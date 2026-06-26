import type { CanonicalMessage, CanonicalUsage } from "../model/index.js";
import type {
  ProjectWikiModelRef,
  ProjectWikiPromptLanguage,
} from "../project-wiki/types.js";

export type UserProfileCategory =
  | "identity"
  | "communication"
  | "workflow"
  | "preference"
  | "constraint"
  | "other";

export type UserProfileSourceType = "conversation" | "legacy_memory";

export type UserProfileSourceRef = {
  kind: string;
  label: string;
  path?: string;
  sessionId?: string;
  turnId?: string;
  excerpt?: string;
  contentHash?: string;
};

export type UserProfileEntryStatus = "active" | "superseded";

export type UserProfileEntry = {
  id: string;
  category: UserProfileCategory;
  content: string;
  confidence?: number;
  status: UserProfileEntryStatus;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  sourceRefs?: UserProfileSourceRef[];
};

export type UserProfileDocument = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  entries: UserProfileEntry[];
};

export type UserProfileSourceCard = {
  id: string;
  sourceType: UserProfileSourceType;
  category?: UserProfileCategory;
  title: string;
  summary: string;
  evidence?: string;
  confidence?: number;
  sourceRefs: UserProfileSourceRef[];
  relativePath: string;
  createdAt: string;
};

export type UserProfileTraceKind = "index" | "maintain" | "migration" | "context";

export type UserProfileTraceRecord = {
  id: string;
  kind: UserProfileTraceKind;
  phase: string;
  createdAt: string;
  sessionId?: string;
  turnId?: string;
  projectRoot?: string;
  model?: ProjectWikiModelRef;
  language?: ProjectWikiPromptLanguage;
  status: "success" | "skipped" | "error";
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  usage?: CanonicalUsage;
  artifacts?: Array<{ kind: "profile_entry" | "source_card" | "profile"; id?: string; path?: string; title?: string }>;
};

export type UserProfileRuntimeConfig = {
  enabled: boolean;
  language: ProjectWikiPromptLanguage;
  maxContextChars: number;
};

export type UserProfileDiagnostic = {
  code:
    | "user_profile_disabled"
    | "user_profile_empty"
    | "user_profile_store_error"
    | "user_profile_model_error";
  message: string;
  severity: "info" | "warning" | "error";
};

export type UserProfileContextInput = {
  sessionId: string;
  turnId?: string;
  signal?: AbortSignal;
};

export type UserProfileContextResult = {
  systemContext?: string;
  diagnostics: UserProfileDiagnostic[];
};

export type UserProfileCaptureTurnInput = {
  sessionId: string;
  turnId: string;
  projectRoot: string;
  transcriptPath?: string;
  messages: CanonicalMessage[];
  errored: boolean;
};

export type UserProfileResolver = {
  getContext(input: UserProfileContextInput): Promise<UserProfileContextResult>;
  captureTurn(input: UserProfileCaptureTurnInput): Promise<void>;
};

export const USER_PROFILE_CATEGORIES: UserProfileCategory[] = [
  "identity",
  "communication",
  "workflow",
  "preference",
  "constraint",
  "other",
];
