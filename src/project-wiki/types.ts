import type { CanonicalMessage, CanonicalUsage } from "../model/index.js";

export type ProjectWikiSourceType = "repo" | "memory" | "conversations" | "knowledge";

export type ProjectWikiPageId =
  | "home"
  | "project-overview"
  | "project-status"
  | "project-feedback"
  | "knowledge";

export type ProjectWikiWikiPageId = Exclude<ProjectWikiPageId, "home">;

export type ProjectWikiModelRole = "indexer" | "maintainer" | "searcher" | "curator";
export type ProjectWikiPromptLanguage = "en" | "zh-CN";

export type ProjectWikiModelRef = {
  provider: string;
  model: string;
};

export type ProjectWikiModelsConfig = Partial<Record<ProjectWikiModelRole, ProjectWikiModelRef>>;

export type ProjectWikiSourcesConfig = {
  repo: boolean;
  memory: boolean;
  conversations: boolean;
  knowledge: boolean;
};

export type ProjectWikiLimitsConfig = {
  maxContextChars: number;
  maxSourceCardsPerTurn: number;
  maxCatalogChars: number;
  maxMaterialChars: number;
  modelTimeoutMs: number;
};

export type ProjectWikiRuntimeConfig = {
  enabled: boolean;
  language: ProjectWikiPromptLanguage;
  rootDir?: string;
  models: ProjectWikiModelsConfig;
  sources: ProjectWikiSourcesConfig;
  limits: ProjectWikiLimitsConfig;
};

export type ProjectWikiSourceRange = {
  startLine?: number;
  endLine?: number;
  messageIndex?: number;
};

export type ProjectWikiSourceRef = {
  kind: string;
  label: string;
  path?: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  excerpt?: string;
  range?: ProjectWikiSourceRange;
  contentHash?: string;
};

export type ProjectWikiSourceEvidenceLevel = "low" | "medium" | "high";

export type ProjectWikiSourceCardDraft = {
  sourceType: ProjectWikiSourceType;
  title: string;
  description: string;
  summary: string;
  tags?: string[];
  status?: "active" | "stale" | "conflict" | "draft";
  statusReason?: string;
  importance?: number;
  evidenceLevel?: ProjectWikiSourceEvidenceLevel;
  confidence?: number;
  qualitySignals?: string[];
  sourceRefs?: ProjectWikiSourceRef[];
};

export type ProjectWikiSourceCardRecord = ProjectWikiSourceCardDraft & {
  id: string;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectWikiSourceChangeKind =
  | "modified"
  | "missing"
  | "unreadable"
  | "unverifiable"
  | "recheck"
  | "inconsistent";

export type ProjectWikiSourceRefChange = {
  kind: ProjectWikiSourceChangeKind;
  reason: string;
  sourceRef: ProjectWikiSourceRef;
  currentSourceRef?: ProjectWikiSourceRef;
  currentEvidence?: string;
};

export type ProjectWikiSourceChangeEvent = {
  sourceCard: ProjectWikiSourceCardRecord;
  sourceCardId: string;
  relativePath: string;
  sourceType: ProjectWikiSourceType;
  observedAt: string;
  changes: ProjectWikiSourceRefChange[];
  suggestedSourceRefs: ProjectWikiSourceRef[];
};

export type ProjectWikiPageDraft = {
  pageId: ProjectWikiPageId;
  title: string;
  description: string;
  body: string;
  sourceCardIds?: string[];
  changeSummary?: string;
};

export type ProjectWikiPageRecord = ProjectWikiPageDraft & {
  relativePath: string;
  updatedAt: string;
};

export type ProjectWikiCatalogEntry = {
  relativePath: string;
  kind: "home" | "wiki" | "source_card";
  title: string;
  description: string;
  sourceCardId?: string;
  sourceType?: ProjectWikiSourceType;
  status?: ProjectWikiSourceCardRecord["status"];
  statusReason?: string;
  sourceCardIds?: string[];
  sourceHealth?: ProjectWikiSourceHealth;
  updatedAt?: string;
  tags?: string[];
  evidenceLevel?: ProjectWikiSourceEvidenceLevel;
  confidence?: number;
  qualitySignals?: string[];
  preview: string;
};

export type ProjectWikiSourceHealth = {
  total: number;
  active: number;
  stale: number;
  conflict: number;
  draft: number;
  missing: number;
  warnings: string[];
};

export type ProjectWikiTraceKind = "index" | "maintain" | "retrieval" | "context";
export type ProjectWikiTracePipelineKind = "ingestion" | "retrieval_context" | "refresh" | "direct_search";

export type ProjectWikiTracePayloadRefs = {
  input?: string;
  output?: string;
  businessInput?: string;
  businessOutput?: string;
  modelRequest?: string;
  modelResponse?: string;
  parsedOutput?: string;
  toolLoopMessages?: string;
};

export type ProjectWikiTraceRecord = {
  id: string;
  kind: ProjectWikiTraceKind;
  phase: string;
  pipelineRunId?: string;
  pipelineKind?: ProjectWikiTracePipelineKind;
  stepIndex?: number;
  stepName?: string;
  parentTraceId?: string;
  projectRoot: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
  durationMs?: number;
  model?: ProjectWikiModelRef;
  language?: ProjectWikiPromptLanguage;
  status: "success" | "skipped" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
  usage?: CanonicalUsage;
  payloadRefs?: ProjectWikiTracePayloadRefs;
  artifacts?: Array<{
    kind: "source_card" | "wiki_page" | "context" | "trace" | "conflict";
    path?: string;
    id?: string;
    title?: string;
  }>;
};

export type ProjectWikiConflictRecord = {
  id: string;
  topic: string;
  summary: string;
  sourceCardIds: string[];
  createdAt: string;
  updatedAt: string;
  status: "open" | "resolved";
  traceId?: string;
};

export type ProjectWikiRetrieveInput = {
  query: string;
  sessionId: string;
  turnId?: string;
  projectRoot: string;
  recentMessages: CanonicalMessage[];
  signal?: AbortSignal;
};

export type ProjectWikiRetrieveResult = {
  systemContext?: string;
  diagnostics: ProjectWikiDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type ProjectWikiSearchInput = ProjectWikiRetrieveInput & {
  limit?: number;
};

export type ProjectWikiSearchResult = {
  selected: Array<{
    relativePath: string;
    reason?: string;
    priority?: number;
    title?: string;
    kind?: ProjectWikiCatalogEntry["kind"];
    sourceType?: ProjectWikiSourceType;
    status?: ProjectWikiSourceCardRecord["status"];
    statusReason?: string;
    sourceHealth?: ProjectWikiSourceHealth;
    preview?: string;
  }>;
  rejected: Array<{ relativePath: string; reason?: string }>;
  needsProjectWiki?: boolean;
  intent?: string;
  notes?: string;
  diagnostics: ProjectWikiDiagnostic[];
};

export type ProjectWikiReadInput = {
  relativePath: string;
  maxChars?: number;
};

export type ProjectWikiReadResult = {
  relativePath: string;
  content: string;
  frontmatter: Record<string, unknown>;
};

export type ProjectWikiCaptureTurnInput = {
  sessionId: string;
  turnId: string;
  projectRoot: string;
  transcriptPath?: string;
  messages: CanonicalMessage[];
  errored: boolean;
};

export type ProjectWikiRefreshInput = {
  sessionId?: string;
  turnId?: string;
  reason?: string;
  maxHistoricalTurns?: number;
};

export type ProjectWikiRefreshResult = {
  refreshed: boolean;
  diagnostics: ProjectWikiDiagnostic[];
  maxHistoricalTurns?: number;
  indexedTurns?: number;
  skippedTurns?: number;
  failedTurns?: number;
  scannedTranscripts?: number;
  discoveredTurns?: number;
  sourceCardsCreated?: number;
  sourceCardsReconciled?: number;
};

export type ProjectWikiDiagnostic = {
  code:
    | "project_wiki_disabled"
    | "project_wiki_context_empty"
    | "project_wiki_model_error"
    | "project_wiki_store_error";
  message: string;
  severity: "info" | "warning" | "error";
};

export type ProjectWikiResolver = {
  retrieve(input: ProjectWikiRetrieveInput): Promise<ProjectWikiRetrieveResult>;
  captureTurn(input: ProjectWikiCaptureTurnInput): Promise<void>;
  search?(input: ProjectWikiSearchInput): Promise<ProjectWikiSearchResult>;
  read?(input: ProjectWikiReadInput): Promise<ProjectWikiReadResult | undefined>;
};

export const PROJECT_WIKI_PAGE_IDS: ProjectWikiWikiPageId[] = [
  "project-overview",
  "project-status",
  "project-feedback",
  "knowledge",
];

export const PROJECT_WIKI_MAINTAINABLE_PAGE_IDS: ProjectWikiPageId[] = [
  "home",
  ...PROJECT_WIKI_PAGE_IDS,
];

export const PROJECT_WIKI_SOURCE_TYPES: ProjectWikiSourceType[] = [
  "repo",
  "memory",
  "conversations",
  "knowledge",
];
