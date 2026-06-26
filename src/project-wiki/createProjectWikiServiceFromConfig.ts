import type { ModelRuntime } from "../model/index.js";
import type { PilotProjectWikiConfig } from "../pilot/config/types.js";
import { resolve } from "node:path";
import {
  getPilotMemoryRootDir,
  getPilotProjectChatDir,
  getPilotProjectWikiRootDir,
  resolveProjectStorageId,
} from "../pilot/paths.js";
import { ProjectWikiModelRunner } from "./ProjectWikiModelRunner.js";
import { ProjectWikiService } from "./ProjectWikiService.js";
import { ProjectWikiStore } from "./ProjectWikiStore.js";
import type {
  ProjectWikiModelRef,
  ProjectWikiModelRole,
  ProjectWikiRuntimeConfig,
} from "./types.js";

export type CreateProjectWikiServiceOptions = {
  config: PilotProjectWikiConfig | undefined;
  modelRuntime: ModelRuntime;
  agentModel: ProjectWikiModelRef;
  projectRoot: string;
  pilotHome: string;
  now?: () => Date;
};

export function createProjectWikiServiceFromConfig(
  options: CreateProjectWikiServiceOptions,
): ProjectWikiService | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;

  const runtimeConfig = toRuntimeConfig(cfg);
  const defaultRootDir = getPilotProjectWikiRootDir(options.projectRoot, options.pilotHome);
  const rootDir = resolveProjectWikiRootDir(
    runtimeConfig.rootDir,
    defaultRootDir,
    options.projectRoot,
    options.pilotHome,
  );
  const store = new ProjectWikiStore({
    rootDir,
    projectRoot: options.projectRoot,
    now: options.now,
  });
  const modelRunner = new ProjectWikiModelRunner({
    modelRuntime: options.modelRuntime,
    models: runtimeConfig.models,
    fallbackModel: options.agentModel,
    timeoutMs: runtimeConfig.limits.modelTimeoutMs,
  });
  return new ProjectWikiService({
    projectRoot: options.projectRoot,
    store,
    modelRunner,
    config: runtimeConfig,
    legacyMemoryRootDir: getPilotMemoryRootDir(options.pilotHome),
    chatDir: getPilotProjectChatDir(options.projectRoot, options.pilotHome),
    now: options.now,
  });
}

function resolveProjectWikiRootDir(
  configuredRootDir: string | undefined,
  defaultRootDir: string,
  projectRoot: string,
  pilotHome: string,
): string {
  if (!configuredRootDir) return defaultRootDir;
  const configured = resolve(configuredRootDir);
  if (configured === resolve(defaultRootDir)) return configured;
  const projectId = resolveProjectStorageId(projectRoot, pilotHome);
  if (configured.includes("{projectId}") || configured.includes("<projectId>")) {
    return configured
      .replaceAll("{projectId}", projectId)
      .replaceAll("<projectId>", projectId);
  }
  if (configured.includes("{project}") || configured.includes("<project>")) {
    return configured
      .replaceAll("{project}", projectId)
      .replaceAll("<project>", projectId);
  }
  return resolve(configured, projectId, "project_wiki");
}

function toRuntimeConfig(config: PilotProjectWikiConfig): ProjectWikiRuntimeConfig {
  const models: Partial<Record<ProjectWikiModelRole, ProjectWikiModelRef>> = {};
  for (const role of ["indexer", "maintainer", "searcher", "curator"] as ProjectWikiModelRole[]) {
    const parsed = parseModelRef(config.models[role]);
    if (parsed) models[role] = parsed;
  }
  return {
    enabled: config.enabled,
    language: config.language,
    rootDir: config.rootDir,
    models,
    sources: config.sources,
    limits: config.limits,
  };
}

function parseModelRef(value: string | undefined): ProjectWikiModelRef | undefined {
  if (!value) return undefined;
  const sep = value.indexOf("/");
  if (sep < 0) return undefined;
  return {
    provider: value.slice(0, sep),
    model: value.slice(sep + 1),
  };
}
