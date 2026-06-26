import { isRecord } from "../../model/config/schema.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import {
  PilotConfigError,
  type PilotConfigDiagnostic,
  type PilotProjectWikiConfig,
  type PilotProjectWikiPromptLanguage,
  type PilotProjectWikiModelRole,
} from "./types.js";

const MODEL_ROLES: PilotProjectWikiModelRole[] = ["indexer", "maintainer", "searcher", "curator"];
const VALID_LANGUAGES = new Set<string>(["en", "zh-CN"]);

export function parseProjectWikiConfig(
  rawProjectWiki: unknown,
  diagnostics: PilotConfigDiagnostic[],
  defaultRootDir: string | undefined,
  modelConfig?: ModelConfig,
): PilotProjectWikiConfig | undefined {
  if (rawProjectWiki === undefined) {
    return {
      enabled: true,
      language: "en",
      rootDir: defaultRootDir,
      models: {},
      sources: parseProjectWikiSources(undefined),
      limits: defaultLimits(),
    };
  }
  if (!isRecord(rawProjectWiki)) {
    diagnostics.push({
      code: "CONFIG_PROJECT_WIKI_INVALID",
      severity: "fatal",
      message: "projectWiki config must be an object.",
      path: "projectWiki",
      recoverable: false,
    });
    return undefined;
  }

  const models = parseProjectWikiModels(rawProjectWiki.models, diagnostics, modelConfig);
  const sources = parseProjectWikiSources(rawProjectWiki.sources);
  const limits = parseProjectWikiLimits(rawProjectWiki.limits);
  const language = parseProjectWikiLanguage(rawProjectWiki.language, diagnostics);

  const KNOWN_FIELDS = new Set(["enabled", "language", "rootDir", "models", "sources", "limits"]);
  for (const key of Object.keys(rawProjectWiki)) {
    if (!KNOWN_FIELDS.has(key)) {
      diagnostics.push({
        code: "CONFIG_PROJECT_WIKI_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown projectWiki field ${key}.`,
        path: `projectWiki.${key}`,
        recoverable: true,
      });
    }
  }

  return {
    enabled: readBoolean(rawProjectWiki.enabled, true, "projectWiki.enabled"),
    language,
    rootDir: readOptionalString(rawProjectWiki.rootDir, "projectWiki.rootDir") ?? defaultRootDir,
    models,
    sources,
    limits,
  };
}

function parseProjectWikiLanguage(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotProjectWikiPromptLanguage {
  if (value === undefined || value === null) return "en";
  if (typeof value === "string" && VALID_LANGUAGES.has(value)) {
    return value as PilotProjectWikiPromptLanguage;
  }
  diagnostics.push({
    code: "CONFIG_PROJECT_WIKI_LANGUAGE_INVALID",
    severity: "warning",
    message: `projectWiki.language must be "en" or "zh-CN"; ignoring "${String(value)}".`,
    path: "projectWiki.language",
    recoverable: true,
  });
  return "en";
}

function parseProjectWikiModels(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): PilotProjectWikiConfig["models"] {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", "projectWiki.models must be an object.");
  }
  const output: PilotProjectWikiConfig["models"] = {};
  for (const role of MODEL_ROLES) {
    const modelRef = parseModelRef(value[role], `projectWiki.models.${role}`, diagnostics, modelConfig);
    if (modelRef) output[role] = modelRef;
  }
  for (const key of Object.keys(value)) {
    if (!MODEL_ROLES.includes(key as PilotProjectWikiModelRole)) {
      diagnostics.push({
        code: "CONFIG_PROJECT_WIKI_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown projectWiki.models field ${key}.`,
        path: `projectWiki.models.${key}`,
        recoverable: true,
      });
    }
  }
  return output;
}

function parseProjectWikiSources(value: unknown): PilotProjectWikiConfig["sources"] {
  if (value === undefined) {
    return {
      repo: true,
      memory: true,
      conversations: true,
      knowledge: true,
    };
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", "projectWiki.sources must be an object.");
  }
  return {
    repo: readBoolean(value.repo, true, "projectWiki.sources.repo"),
    memory: readBoolean(value.memory, true, "projectWiki.sources.memory"),
    conversations: readBoolean(value.conversations, true, "projectWiki.sources.conversations"),
    knowledge: readBoolean(value.knowledge, true, "projectWiki.sources.knowledge"),
  };
}

function parseProjectWikiLimits(value: unknown): PilotProjectWikiConfig["limits"] {
  if (value === undefined) {
    return defaultLimits();
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", "projectWiki.limits must be an object.");
  }
  return {
    maxContextChars: readPositiveInteger(value.maxContextChars, 12_000, "projectWiki.limits.maxContextChars"),
    maxSourceCardsPerTurn: readPositiveInteger(
      value.maxSourceCardsPerTurn,
      12,
      "projectWiki.limits.maxSourceCardsPerTurn",
    ),
    maxCatalogChars: readPositiveInteger(value.maxCatalogChars, 24_000, "projectWiki.limits.maxCatalogChars"),
    maxMaterialChars: readPositiveInteger(value.maxMaterialChars, 8_000, "projectWiki.limits.maxMaterialChars"),
    modelTimeoutMs: readPositiveInteger(value.modelTimeoutMs, 60_000, "projectWiki.limits.modelTimeoutMs"),
  };
}

function defaultLimits(): PilotProjectWikiConfig["limits"] {
  return {
    maxContextChars: 12_000,
    maxSourceCardsPerTurn: 12,
    maxCatalogChars: 24_000,
    maxMaterialChars: 8_000,
    modelTimeoutMs: 60_000,
  };
}

function parseModelRef(
  value: unknown,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): string | undefined {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_MODEL_INVALID", `${path} must be a "provider/model" string.`);
  }
  const sep = value.indexOf("/");
  if (sep < 0) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_MODEL_INVALID", `${path} must use "provider/model" format.`);
  }
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (modelConfig) {
    if (!modelConfig.providers[providerId]) {
      diagnostics.push({
        code: "CONFIG_PROJECT_WIKI_MODEL_PROVIDER_NOT_FOUND",
        severity: "warning",
        message: `${path} references unknown provider ${providerId}.`,
        path,
        recoverable: true,
      });
    } else if (!modelConfig.providers[providerId].models[modelId]) {
      diagnostics.push({
        code: "CONFIG_PROJECT_WIKI_MODEL_NOT_FOUND",
        severity: "warning",
        message: `${path} references unknown model ${modelId} for provider ${providerId}.`,
        path,
        recoverable: true,
      });
    }
  }
  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", `${path} must be a non-empty string.`);
  }
  return value;
}

function readBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", `${path} must be a boolean.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PilotConfigError("CONFIG_PROJECT_WIKI_VALUE_INVALID", `${path} must be a positive number.`);
  }
  return Math.floor(value);
}
