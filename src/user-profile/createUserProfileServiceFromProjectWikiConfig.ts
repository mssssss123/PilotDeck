import type { ModelRuntime } from "../model/index.js";
import type { PilotProjectWikiConfig } from "../pilot/config/types.js";
import {
  getPilotMemoryRootDir,
  getPilotUserProfileRootDir,
} from "../pilot/paths.js";
import { ProjectWikiModelRunner } from "../project-wiki/ProjectWikiModelRunner.js";
import type {
  ProjectWikiModelRef,
  ProjectWikiModelRole,
} from "../project-wiki/types.js";
import { UserProfileService } from "./UserProfileService.js";
import { UserProfileStore } from "./UserProfileStore.js";
import type { UserProfileRuntimeConfig } from "./types.js";

export type CreateUserProfileServiceOptions = {
  config: PilotProjectWikiConfig | undefined;
  modelRuntime: ModelRuntime;
  agentModel: ProjectWikiModelRef;
  pilotHome: string;
  now?: () => Date;
};

export function createUserProfileServiceFromProjectWikiConfig(
  options: CreateUserProfileServiceOptions,
): UserProfileService | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;
  const runtimeConfig: UserProfileRuntimeConfig = {
    enabled: true,
    language: cfg.language,
    maxContextChars: Math.min(cfg.limits.maxContextChars, 3_000),
  };
  const models: Partial<Record<ProjectWikiModelRole, ProjectWikiModelRef>> = {};
  for (const role of ["indexer", "maintainer"] as ProjectWikiModelRole[]) {
    const parsed = parseModelRef(cfg.models[role]);
    if (parsed) models[role] = parsed;
  }
  const modelRunner = new ProjectWikiModelRunner({
    modelRuntime: options.modelRuntime,
    models,
    fallbackModel: options.agentModel,
    timeoutMs: cfg.limits.modelTimeoutMs,
  });
  const store = new UserProfileStore({
    rootDir: getPilotUserProfileRootDir(options.pilotHome),
    language: cfg.language,
    now: options.now,
  });
  return new UserProfileService({
    store,
    modelRunner,
    config: runtimeConfig,
    legacyMemoryRootDir: getPilotMemoryRootDir(options.pilotHome),
    now: options.now,
  });
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
