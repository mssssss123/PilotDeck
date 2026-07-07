import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { CanonicalMessage, CanonicalToolSchema, CanonicalUsage } from "../model/index.js";
import { readTranscript, type AgentTranscriptEntry } from "../session/index.js";
import {
  ProjectWikiModelRunner,
  projectWikiModelRequestFromError,
  type ProjectWikiStructuredCallResult,
} from "./ProjectWikiModelRunner.js";
import { ProjectWikiStore, truncateText, type ProjectWikiMarkdownFile } from "./ProjectWikiStore.js";
import {
  PROJECT_WIKI_CURATOR_SYSTEM_PROMPT,
  PROJECT_WIKI_INDEXER_SYSTEM_PROMPT,
  PROJECT_WIKI_MAINTAINER_SYSTEM_PROMPT,
  PROJECT_WIKI_RECONCILER_SYSTEM_PROMPT,
  PROJECT_WIKI_RETRIEVER_AGENT_SYSTEM_PROMPT,
  PROJECT_WIKI_SEARCHER_SYSTEM_PROMPT,
  projectWikiLanguageName,
  withProjectWikiOutputLanguage,
} from "./prompts.js";
import {
  curateOutputSchema,
  indexOutputSchema,
  isCurateOutput,
  isIndexOutput,
  isMaintainOutput,
  isSearchOutput,
  isSourceReconcileOutput,
  maintainOutputSchema,
  searchOutputSchema,
  sourceReconcileOutputSchema,
  type ProjectWikiCurateOutput,
  type ProjectWikiIndexOutput,
  type ProjectWikiMaintainOutput,
  type ProjectWikiSearchOutput,
  type ProjectWikiSourceReconcileOutput,
} from "./schemas.js";
import type {
  ProjectWikiCaptureTurnInput,
  ProjectWikiActivityMaterial,
  ProjectWikiCatalogEntry,
  ProjectWikiConflictRecord,
  ProjectWikiDiagnostic,
  ProjectWikiPageId,
  ProjectWikiModelRef,
  ProjectWikiPromptLanguage,
  ProjectWikiReadInput,
  ProjectWikiReadResult,
  ProjectWikiRefreshInput,
  ProjectWikiRefreshResult,
  ProjectWikiRetrieveInput,
  ProjectWikiRetrieveResult,
  ProjectWikiRuntimeConfig,
  ProjectWikiSearchInput,
  ProjectWikiSearchResult,
  ProjectWikiSourceCardDraft,
  ProjectWikiSourceCardRecord,
  ProjectWikiSourceChangeEvent,
  ProjectWikiSourceRef,
  ProjectWikiSourceType,
  ProjectWikiTraceRecord,
} from "./types.js";
import { PROJECT_WIKI_MAINTAINABLE_PAGE_IDS, PROJECT_WIKI_PAGE_IDS, PROJECT_WIKI_SOURCE_TYPES } from "./types.js";

const TRACE_PREVIEW_CHARS = 1_200;
const TRACE_FIELD_PREVIEW_CHARS = 700;
const TRACE_ARRAY_LIMIT = 40;
const RETRIEVER_MAX_STEPS = 4;
const RETRIEVER_MAX_SEARCH_CALLS = 1;
const RETRIEVER_MAX_READ_CALLS = 2;
const HISTORY_BACKFILL_MAX_TRANSCRIPTS = 40;
const HISTORY_BACKFILL_MAX_TURNS = 120;
const HISTORY_BACKFILL_STATE_VERSION = 1;
const LEGACY_MEMORY_MIGRATION_STATE_VERSION = 1;

const PROJECT_WIKI_RETRIEVER_TOOLS: CanonicalToolSchema[] = [
  {
    name: "projectwiki_search",
    description: "Ask the ProjectWiki Searcher model to select relevant wiki pages or source cards from the ProjectWiki catalog.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Focused natural-language query for candidate ProjectWiki materials.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of candidate catalog entries to return.",
        },
      },
    },
  },
  {
    name: "projectwiki_read",
    description: "Read one markdown file inside ProjectWiki by relative path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["relativePath"],
      properties: {
        relativePath: {
          type: "string",
          description: "ProjectWiki-relative markdown path, such as wiki/knowledge.md.",
        },
        maxChars: {
          type: "integer",
          description: "Optional maximum number of characters to return.",
        },
      },
    },
  },
  {
    name: "projectwiki_finish",
    description: "Finish ProjectWiki retrieval with the final selected and rejected materials.",
    inputSchema: searchOutputSchema,
  },
];

export type ProjectWikiServiceOptions = {
  projectRoot: string;
  store: ProjectWikiStore;
  modelRunner: ProjectWikiModelRunner;
  config: ProjectWikiRuntimeConfig;
  legacyMemoryRootDir?: string;
  chatDir?: string;
  repoDigestBuilder?: (projectRoot: string) => Promise<RepoDigestMaterial>;
  now?: () => Date;
};

type ModelTraceBase = Pick<
  ProjectWikiTraceRecord,
  "kind" | "phase" | "projectRoot" | "sessionId" | "turnId" | "language"
>;
type TracePipelineKind = NonNullable<ProjectWikiTraceRecord["pipelineKind"]>;
type TracePipelineContext = {
  pipelineRunId: string;
  pipelineKind: TracePipelineKind;
};
type TraceableProjectWikiCaptureInput = ProjectWikiCaptureTurnInput & {
  tracePipeline?: TracePipelineContext;
};

type RepoDigestState = {
  contentHash: string;
  indexedAt: string;
};

export type RepoDigestMaterial = {
  digest: string;
  sourceRefs: ProjectWikiSourceRef[];
  files: Array<{
    relativePath: string;
    path: string;
    size: number;
    contentHash: string;
    lineCount: number;
  }>;
};

type QueuedProjectWikiCaptureInput = TraceableProjectWikiCaptureInput & {
  repoMaterial?: RepoDigestMaterial;
  recheckStaleSources?: boolean;
};

type IndexTurnResult = {
  cards: ProjectWikiSourceCardRecord[];
  status: "success" | "skipped" | "error";
};

type ProcessCaptureTurnResult = {
  cards: ProjectWikiSourceCardRecord[];
  sourceCardsCreated: number;
  sourceCardsReconciled: number;
};

type HistoricalTurnMaterial = TraceableProjectWikiCaptureInput & {
  contentHash: string;
  createdAt: string;
  transcriptPath: string;
  tracePipeline?: TracePipelineContext;
};

type HistoryBackfillState = {
  version: number;
  turns: Record<string, {
    contentHash: string;
    indexedAt: string;
    transcriptPath: string;
    sessionId: string;
    turnId: string;
  }>;
};

type LegacyMemoryMigrationState = {
  version: number;
  status: "completed" | "skipped" | "error";
  projectRoot: string;
  sourceRoot: string;
  sourceHash: string;
  sourceFiles: number;
  sourceCardIds: string[];
  sourceCardPaths: string[];
  createdSourceCards: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
};

type LegacyMemoryFile = {
  path: string;
  content: string;
  contentHash: string;
  lineCount: number;
};

type HistoryBackfillResult = {
  maxHistoricalTurns: number;
  scannedTranscripts: number;
  discoveredTurns: number;
  indexedTurns: number;
  skippedTurns: number;
  failedTurns: number;
  sourceCardsCreated: number;
};

type RetrieverToolCall = Extract<CanonicalMessage["content"][number], { type: "tool_call" }>;

type RetrieverLoopResult = {
  value: ProjectWikiSearchOutput;
  traceOutput: unknown;
  model: ProjectWikiModelRef;
  usage?: CanonicalUsage;
};

type OpenConflictContext = {
  id: string;
  topic: string;
  summary: string;
  sourceCardIds: string[];
  sourcePaths: string[];
  traceId?: string;
  updatedAt?: string;
};

export class ProjectWikiService {
  private readonly projectRoot: string;
  private readonly store: ProjectWikiStore;
  private readonly modelRunner: ProjectWikiModelRunner;
  private readonly config: ProjectWikiRuntimeConfig;
  private readonly legacyMemoryRootDir?: string;
  private readonly chatDir?: string;
  private readonly repoDigestBuilder: (projectRoot: string) => Promise<RepoDigestMaterial>;
  private readonly now: () => Date;
  private indexingQueue: Promise<void> = Promise.resolve();
  private maintenanceQueue: Promise<void> = Promise.resolve();

  constructor(options: ProjectWikiServiceOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.store = options.store;
    this.modelRunner = options.modelRunner;
    this.config = options.config;
    this.legacyMemoryRootDir = options.legacyMemoryRootDir;
    this.chatDir = options.chatDir ? resolve(options.chatDir) : undefined;
    this.repoDigestBuilder = options.repoDigestBuilder ?? buildRepoDigestMaterial;
    this.now = options.now ?? (() => new Date());
  }

  private get repoDigestStatePath(): string {
    return join(this.store.rootDir, "state", "repo-digest.json");
  }

  private get historyBackfillStatePath(): string {
    return join(this.store.rootDir, "state", "history-backfill.json");
  }

  private get legacyMemoryMigrationStatePath(): string {
    return join(this.store.rootDir, "state", "migrations", "legacy-memory-v1.json");
  }

  private get outputLanguage(): ProjectWikiPromptLanguage {
    return this.config.language;
  }

  private get outputLanguageInput(): { outputLanguage: ProjectWikiPromptLanguage; outputLanguageName: string } {
    return {
      outputLanguage: this.outputLanguage,
      outputLanguageName: projectWikiLanguageName(this.outputLanguage),
    };
  }

  private systemPrompt(basePrompt: string): string {
    return withProjectWikiOutputLanguage(basePrompt, this.outputLanguage);
  }

  private traceBase(
    kind: ModelTraceBase["kind"],
    phase: string,
    input: { sessionId?: string; turnId?: string },
  ): ModelTraceBase {
    return traceBase(kind, phase, this.projectRoot, input, this.outputLanguage);
  }

  private createTracePipeline(
    pipelineKind: TracePipelineKind,
    input: { sessionId?: string; turnId?: string },
  ): TracePipelineContext {
    const sessionId = input.sessionId || "no-session";
    const turnId = input.turnId || `run-${timestampSlug(this.now().toISOString())}`;
    return {
      pipelineKind,
      pipelineRunId: `${pipelineKind}:${hashText(`${this.projectRoot}\n${sessionId}\n${turnId}`).slice(0, 16)}`,
    };
  }

  private emitActivity(
    input: ProjectWikiRetrieveInput,
    pipeline: TracePipelineContext,
    activity: Parameters<NonNullable<ProjectWikiRetrieveInput["onActivity"]>>[0],
  ): void {
    try {
      input.onActivity?.({
        ...activity,
        query: activity.query ?? input.query,
        projectRoot: activity.projectRoot ?? input.projectRoot,
        pipelineRunId: activity.pipelineRunId ?? pipeline.pipelineRunId,
      });
    } catch {
      // ProjectWiki visibility must never break retrieval.
    }
  }

  private async readRepoDigestState(): Promise<RepoDigestState | undefined> {
    const state = await readJsonFile<RepoDigestState>(this.repoDigestStatePath);
    return state && typeof state.contentHash === "string" && typeof state.indexedAt === "string"
      ? state
      : undefined;
  }

  private async writeRepoDigestState(state: RepoDigestState): Promise<void> {
    await writeJsonFile(this.repoDigestStatePath, state);
  }

  private async readHistoryBackfillState(): Promise<HistoryBackfillState> {
    const state = await readJsonFile<HistoryBackfillState>(this.historyBackfillStatePath);
    if (
      state
      && state.version === HISTORY_BACKFILL_STATE_VERSION
      && isRecord(state.turns)
    ) {
      return {
        version: HISTORY_BACKFILL_STATE_VERSION,
        turns: Object.fromEntries(Object.entries(state.turns).filter(([, value]) =>
          isRecord(value)
          && typeof value.contentHash === "string"
          && typeof value.indexedAt === "string"
          && typeof value.transcriptPath === "string"
          && typeof value.sessionId === "string"
          && typeof value.turnId === "string")),
      };
    }
    return { version: HISTORY_BACKFILL_STATE_VERSION, turns: {} };
  }

  private async writeHistoryBackfillState(state: HistoryBackfillState): Promise<void> {
    await writeJsonFile(this.historyBackfillStatePath, state);
  }

  private async readLegacyMemoryMigrationState(): Promise<LegacyMemoryMigrationState | undefined> {
    const state = await readJsonFile<LegacyMemoryMigrationState>(this.legacyMemoryMigrationStatePath);
    if (
      state
      && state.version === LEGACY_MEMORY_MIGRATION_STATE_VERSION
      && (state.status === "completed" || state.status === "skipped" || state.status === "error")
      && typeof state.projectRoot === "string"
      && typeof state.sourceRoot === "string"
      && typeof state.sourceHash === "string"
      && typeof state.sourceFiles === "number"
      && Array.isArray(state.sourceCardIds)
      && Array.isArray(state.sourceCardPaths)
      && typeof state.createdSourceCards === "number"
      && typeof state.startedAt === "string"
    ) {
      return state;
    }
    return undefined;
  }

  private async writeLegacyMemoryMigrationState(state: LegacyMemoryMigrationState): Promise<void> {
    await writeJsonFile(this.legacyMemoryMigrationStatePath, state);
  }

  async retrieve(input: ProjectWikiRetrieveInput): Promise<ProjectWikiRetrieveResult> {
    if (!this.config.enabled) {
      return {
        diagnostics: [{
          code: "project_wiki_disabled",
          severity: "info",
          message: "ProjectWiki is disabled.",
        }],
      };
    }
    await this.store.ensureInitialized();
    const diagnostics: ProjectWikiDiagnostic[] = [];
    const pipeline = this.createTracePipeline("retrieval_context", input);
    this.emitActivity(input, pipeline, {
      phase: "started",
      state: "running",
      title: this.outputLanguage === "zh-CN" ? "ProjectWiki 正在判断是否需要项目上下文" : "ProjectWiki is checking project context",
      detail: input.query,
    });

    try {
      const catalog = filterRetrievableCatalog(
        await this.store.listCatalog(this.config.limits.maxCatalogChars),
      );
      const modelCatalog = await this.buildModelCatalog(catalog);
      this.emitActivity(input, pipeline, {
        phase: "catalog",
        state: "running",
        title: this.outputLanguage === "zh-CN" ? "ProjectWiki 已加载可用材料" : "ProjectWiki loaded available materials",
        detail: this.outputLanguage === "zh-CN"
          ? `发现 ${modelCatalog.length} 个 Wiki 页面或来源卡片。`
          : `Found ${modelCatalog.length} wiki pages or source cards.`,
        catalog: modelCatalog.map(activityMaterialFromCatalogEntry),
        stats: { catalogCount: modelCatalog.length },
      });
      const openConflicts = await this.buildOpenConflictContext(modelCatalog);
      const recent = canonicalMessagesToTextDigest(input.recentMessages, 4_000);
      const searchInput = {
        ...this.outputLanguageInput,
        query: input.query,
        recentMessages: recent,
        catalog: modelCatalog,
        openConflicts,
      };
      this.emitActivity(input, pipeline, {
        phase: "retriever",
        state: "running",
        title: this.outputLanguage === "zh-CN" ? "Retriever 正在阅读 ProjectWiki 目录" : "Retriever is reading the ProjectWiki catalog",
        detail: this.outputLanguage === "zh-CN"
          ? "模型正在决定是否搜索、读取材料或直接结束。"
          : "The model is deciding whether to search, read materials, or finish.",
        catalog: modelCatalog.map(activityMaterialFromCatalogEntry),
        stats: { catalogCount: modelCatalog.length },
      });
      const retrieverSearch = await this.runRetrieverLoop(input, searchInput, modelCatalog, pipeline);
      let searchValue: ProjectWikiSearchOutput;
      if (retrieverSearch) {
        searchValue = retrieverSearch.value;
      } else {
        const searchStarted = Date.now();
        let search: ProjectWikiStructuredCallResult<ProjectWikiSearchOutput>;
        const fallbackSignal = createLinkedAbortSignal(input.signal);
        try {
          this.emitActivity(input, pipeline, {
            phase: "search",
            state: "running",
            title: this.outputLanguage === "zh-CN" ? "Searcher 正在选择候选材料" : "Searcher is selecting candidate materials",
            detail: input.query,
            catalog: modelCatalog.map(activityMaterialFromCatalogEntry),
            stats: { catalogCount: modelCatalog.length },
          });
          search = await this.modelRunner.structured<ProjectWikiSearchOutput>({
            role: "searcher",
            systemPrompt: this.systemPrompt(PROJECT_WIKI_SEARCHER_SYSTEM_PROMPT),
            userPrompt: JSON.stringify(searchInput, null, 2),
            schema: searchOutputSchema,
            schemaName: "project_wiki_search",
            maxOutputTokens: 2048,
            signal: fallbackSignal.signal,
            validate: isSearchOutput,
          });
        } catch (error) {
          const message = errorMessage(error);
          this.emitActivity(input, pipeline, {
            phase: "error",
            state: "failed",
            title: this.outputLanguage === "zh-CN" ? "ProjectWiki 检索判断失败" : "ProjectWiki retrieval decision failed",
            detail: message,
            error: message,
          });
          await this.store.appendTrace({
            ...this.traceBase("retrieval", "search_failed", input),
            status: "error",
            model: this.modelRunner.resolveModel("searcher"),
            durationMs: Date.now() - searchStarted,
            ...traceStep(pipeline, 2, "retrieval_decision"),
            input: compactTracePayload(searchInput),
            rawInput: searchInput,
            error: message,
            payloads: modelErrorTracePayloads(error),
          });
          return {
            diagnostics: [{
              code: "project_wiki_model_error",
              severity: "warning",
              message: `ProjectWiki Searcher failed: ${message}`,
            }],
          };
        } finally {
          fallbackSignal.cleanup();
        }
        const selection = validateSearchOutputSelection(
          search.value,
          modelCatalog,
          this.config.limits.maxSourceCardsPerTurn,
        );
        searchValue = selection.value;
        const selectedPaths = selection.selectedPaths;
        await this.store.appendTrace({
          ...this.traceBase("retrieval", "search", input),
          status: "success",
          model: search.model,
          durationMs: Date.now() - searchStarted,
          ...traceStep(pipeline, 2, "retrieval_decision"),
          input: compactTracePayload(searchInput),
          output: compactTracePayload(selection.traceOutput),
          rawInput: searchInput,
          rawOutput: selection.traceOutput,
          payloads: {
            ...modelTracePayloads(search),
            businessOutput: selection.traceOutput,
          },
          usage: search.response.usage,
          artifacts: selectedPaths.map(traceArtifactForPath),
        });
      }
      const finalSelection = validateSearchOutputSelection(
        searchValue,
        modelCatalog,
        this.config.limits.maxSourceCardsPerTurn,
      );
      searchValue = finalSelection.value;
      const selectedPaths = finalSelection.selectedPaths;
      const selectedActivityMaterials = selectedActivityMaterialsFromSearch(searchValue, modelCatalog);
      const rejectedActivityMaterials = rejectedActivityMaterialsFromSearch(searchValue, modelCatalog);
      this.emitActivity(input, pipeline, {
        phase: selectedPaths.length > 0 ? "selected" : "skipped",
        state: searchValue.needsProjectWiki === false || selectedPaths.length === 0 ? "skipped" : "running",
        title: selectedPaths.length > 0
          ? this.outputLanguage === "zh-CN" ? "ProjectWiki 已选中相关材料" : "ProjectWiki selected relevant materials"
          : this.outputLanguage === "zh-CN" ? "ProjectWiki 本轮未召回项目上下文" : "ProjectWiki skipped project context for this turn",
        detail: searchValue.intent || searchValue.notes,
        selected: selectedActivityMaterials,
        rejected: rejectedActivityMaterials,
        stats: {
          catalogCount: modelCatalog.length,
          selectedCount: selectedActivityMaterials.length,
          rejectedCount: rejectedActivityMaterials.length,
        },
      });

      if (searchValue.needsProjectWiki === false || selectedPaths.length === 0) {
        diagnostics.push({
          code: "project_wiki_context_empty",
          severity: "info",
          message: "ProjectWiki Searcher selected no context for this turn.",
        });
        return { diagnostics, metadata: { search: searchValue } };
      }

      const readStarted = Date.now();
      const materials = await this.store.readMany(selectedPaths);
      const readInput = {
        query: input.query,
        selectedPaths,
        maxMaterialChars: this.config.limits.maxMaterialChars,
      };
      const readOutput = {
        materials: materials.map((file) => ({
          relativePath: file.relativePath,
          frontmatter: file.frontmatter,
          chars: file.content.length,
          preview: truncateText(file.content.replace(/\s+/g, " ").trim(), 360),
        })),
        missingPaths: selectedPaths.filter((path) => !materials.some((file) => file.relativePath === path)),
      };
      this.emitActivity(input, pipeline, {
        phase: "read",
        state: materials.length > 0 ? "running" : "skipped",
        title: this.outputLanguage === "zh-CN" ? "ProjectWiki 正在读取选中材料" : "ProjectWiki is reading selected materials",
        detail: this.outputLanguage === "zh-CN"
          ? `已读取 ${materials.length} 个材料。`
          : `Read ${materials.length} materials.`,
        selected: selectedActivityMaterials,
        rejected: rejectedActivityMaterials,
        read: materials.map((file) => activityMaterialFromMarkdownFile(file, modelCatalog)),
        stats: {
          catalogCount: modelCatalog.length,
          selectedCount: selectedActivityMaterials.length,
          rejectedCount: rejectedActivityMaterials.length,
          readCount: materials.length,
        },
      });
      await this.store.appendTrace({
        ...this.traceBase("retrieval", "read", input),
        status: materials.length > 0 ? "success" : "skipped",
        durationMs: Date.now() - readStarted,
        ...traceStep(pipeline, 3, "read_materials"),
        input: compactTracePayload(readInput),
        output: compactTracePayload(readOutput),
        rawInput: readInput,
        rawOutput: readOutput,
        artifacts: materials.map((file) => traceArtifactForPath(file.relativePath)),
      });

      const catalogByPath = new Map(modelCatalog.map((entry) => [entry.relativePath, entry]));
      const materialPayload = materials.map((file) => ({
        relativePath: file.relativePath,
        frontmatter: file.frontmatter,
        catalog: catalogByPath.get(file.relativePath),
        content: truncateText(file.content, this.config.limits.maxMaterialChars),
      }));
      const selectedPathSet = new Set(selectedPaths);
      const curateInput = {
        ...this.outputLanguageInput,
        selected: (searchValue.selected ?? [])
          .filter((item) => item.relativePath && selectedPathSet.has(item.relativePath)),
        materials: materialPayload,
        openConflicts,
      };
      const curateStarted = Date.now();
      let curated: ProjectWikiStructuredCallResult<ProjectWikiCurateOutput>;
      try {
        this.emitActivity(input, pipeline, {
          phase: "curator",
          state: "running",
          title: this.outputLanguage === "zh-CN" ? "Curator 正在组装主智能体上下文" : "Curator is assembling main-agent context",
          detail: this.outputLanguage === "zh-CN"
            ? `基于 ${materials.length} 个已读材料生成本轮上下文。`
            : `Building turn context from ${materials.length} read materials.`,
          selected: selectedActivityMaterials,
          rejected: rejectedActivityMaterials,
          read: materials.map((file) => activityMaterialFromMarkdownFile(file, modelCatalog)),
          stats: {
            catalogCount: modelCatalog.length,
            selectedCount: selectedActivityMaterials.length,
            rejectedCount: rejectedActivityMaterials.length,
            readCount: materials.length,
          },
        });
        curated = await this.modelRunner.structured<ProjectWikiCurateOutput>({
          role: "curator",
          systemPrompt: this.systemPrompt(PROJECT_WIKI_CURATOR_SYSTEM_PROMPT),
          userPrompt: JSON.stringify(curateInput, null, 2),
          schema: curateOutputSchema,
          schemaName: "project_wiki_curate",
          maxOutputTokens: Math.max(2048, Math.ceil(this.config.limits.maxContextChars / 2)),
          signal: input.signal,
          validate: isCurateOutput,
        });
      } catch (error) {
        const message = errorMessage(error);
        this.emitActivity(input, pipeline, {
          phase: "error",
          state: "failed",
          title: this.outputLanguage === "zh-CN" ? "ProjectWiki 上下文组装失败" : "ProjectWiki context assembly failed",
          detail: message,
          selected: selectedActivityMaterials,
          rejected: rejectedActivityMaterials,
          read: materials.map((file) => activityMaterialFromMarkdownFile(file, modelCatalog)),
          error: message,
          stats: {
            catalogCount: modelCatalog.length,
            selectedCount: selectedActivityMaterials.length,
            rejectedCount: rejectedActivityMaterials.length,
            readCount: materials.length,
          },
        });
        await this.store.appendTrace({
          ...this.traceBase("context", "assemble_failed", input),
          status: "error",
          model: this.modelRunner.resolveModel("curator"),
          durationMs: Date.now() - curateStarted,
          ...traceStep(pipeline, 4, "assemble_context"),
          input: compactTracePayload(curateInput),
          rawInput: curateInput,
          error: message,
          payloads: modelErrorTracePayloads(error),
          artifacts: selectedPaths.map(traceArtifactForPath),
        });
        return {
          diagnostics: [{
            code: "project_wiki_model_error",
            severity: "warning",
          message: `ProjectWiki Curator failed: ${message}`,
        }],
          metadata: { search: searchValue, selectedPaths },
        };
      }
      const context = normalizeCuratedContext(curated.value, this.config.limits.maxContextChars);
      const curatedSections = curated.value.sections ?? [];
      this.emitActivity(input, pipeline, {
        phase: context ? "assembled" : "skipped",
        state: context ? "completed" : "skipped",
        title: context
          ? this.outputLanguage === "zh-CN" ? "ProjectWiki 已组装本轮上下文" : "ProjectWiki assembled context for this turn"
          : this.outputLanguage === "zh-CN" ? "ProjectWiki 未生成可用上下文" : "ProjectWiki did not produce usable context",
        detail: context
          ? this.outputLanguage === "zh-CN"
            ? `生成 ${curatedSections.length} 段上下文。`
            : `Generated ${curatedSections.length} context sections.`
          : undefined,
        selected: selectedActivityMaterials,
        rejected: rejectedActivityMaterials,
        read: materials.map((file) => activityMaterialFromMarkdownFile(file, modelCatalog)),
        contextPreview: context ? truncateText(context.replace(/\s+/g, " ").trim(), 900) : undefined,
        contextSections: curatedSections.map((section) => ({
          title: section.title,
          sourcePaths: section.sourcePaths,
        })),
        stats: {
          catalogCount: modelCatalog.length,
          selectedCount: selectedActivityMaterials.length,
          rejectedCount: rejectedActivityMaterials.length,
          readCount: materials.length,
          contextSectionCount: curatedSections.length,
        },
      });
      await this.store.appendTrace({
        ...this.traceBase("context", "assemble", input),
        status: context ? "success" : "skipped",
        model: curated.model,
        durationMs: Date.now() - curateStarted,
        ...traceStep(pipeline, 4, "assemble_context"),
        input: compactTracePayload(curateInput),
        output: compactTracePayload(curated.value),
        rawInput: curateInput,
        rawOutput: curated.value,
        payloads: modelTracePayloads(curated),
        usage: curated.response.usage,
        artifacts: context ? [
          { kind: "context", title: "project-wiki-context" },
          ...traceArtifactsForCuratedOutput(curated.value),
        ] : [],
      });

      if (!context) {
        diagnostics.push({
          code: "project_wiki_context_empty",
          severity: "info",
          message: "ProjectWiki Curator returned no context.",
        });
        return { diagnostics, metadata: { search: searchValue, curated: curated.value } };
      }

      return {
        systemContext: context,
        diagnostics,
        metadata: {
          search: searchValue,
          selectedPaths,
        },
      };
    } catch (error) {
      const message = errorMessage(error);
      this.emitActivity(input, pipeline, {
        phase: "error",
        state: "failed",
        title: this.outputLanguage === "zh-CN" ? "ProjectWiki 上下文准备失败" : "ProjectWiki context preparation failed",
        detail: message,
        error: message,
      });
      await this.store.appendTrace({
        ...this.traceBase("context", "retrieve_failed", input),
        status: "error",
        ...traceStep(pipeline, 99, "retrieval_failed"),
        error: message,
      });
      return {
        diagnostics: [{
          code: "project_wiki_model_error",
          severity: "warning",
          message: `ProjectWiki retrieval failed: ${message}`,
        }],
      };
    }
  }

  private async runRetrieverLoop(
    input: ProjectWikiRetrieveInput,
    searchInput: {
      query: string;
      recentMessages: string;
      catalog: ProjectWikiCatalogEntry[];
      openConflicts: OpenConflictContext[];
    },
    catalog: ProjectWikiCatalogEntry[],
    pipeline: TracePipelineContext,
  ): Promise<RetrieverLoopResult | undefined> {
    const started = Date.now();
    const rawInput = {
      ...this.outputLanguageInput,
      query: searchInput.query,
      recentMessages: searchInput.recentMessages,
      catalog: searchInput.catalog,
      openConflicts: searchInput.openConflicts,
      tools: PROJECT_WIKI_RETRIEVER_TOOLS.map((tool) => tool.name),
    };
    const messages: CanonicalMessage[] = [{
      role: "user",
      content: [{
        type: "text",
        text: JSON.stringify(rawInput, null, 2),
      }],
      metadata: { synthetic: true, purpose: "project_wiki_retriever_input" },
    }];
    const toolEvents: Array<Record<string, unknown>> = [];
    let usage: CanonicalUsage | undefined;
    let model = this.modelRunner.resolveModel("searcher");
    let searchCallCount = 0;
    let readCallCount = 0;
    const readPaths = new Set<string>();

    try {
      for (let step = 0; step < RETRIEVER_MAX_STEPS; step += 1) {
        const roundStarted = Date.now();
        const result = await this.modelRunner.complete({
          role: "searcher",
          systemPrompt: this.systemPrompt(PROJECT_WIKI_RETRIEVER_AGENT_SYSTEM_PROMPT),
          messages,
          tools: PROJECT_WIKI_RETRIEVER_TOOLS,
          maxOutputTokens: 2048,
          signal: input.signal,
        });
        model = result.model;
        usage = mergeUsage(usage, result.response.usage);
        const toolCalls = extractToolCalls(result.response.content);
        const finishCall = toolCalls.find((call) => call.name === "projectwiki_finish");
        if (finishCall) {
          if (!isSearchOutput(finishCall.input)) {
            throw new Error("ProjectWiki Retriever finish payload did not match search output shape.");
          }
          const selection = validateSearchOutputSelection(
            finishCall.input,
            catalog,
            this.config.limits.maxSourceCardsPerTurn,
          );
          const value = selection.value;
          const selectedPaths = selection.selectedPaths;
          const rawOutput = {
            ...selection.traceOutput,
            toolEvents,
          };
          await this.store.appendTrace({
            ...this.traceBase("retrieval", "retriever_finish", input),
            status: value.needsProjectWiki === false || selectedPaths.length === 0 ? "skipped" : "success",
            model,
            durationMs: Date.now() - roundStarted,
            ...traceStep(pipeline, retrieverRoundStepIndex(step, 0), "retriever_finish"),
            input: compactTracePayload({ ...rawInput, toolEvents }),
            output: compactTracePayload(rawOutput),
            rawInput: { ...rawInput, toolEvents },
            rawOutput,
            payloads: {
              modelRequest: result.request,
              modelResponse: result.response,
              parsedOutput: selection.value,
              retrieverMessages: messages,
            },
            usage: result.response.usage,
            artifacts: selectedPaths.map(traceArtifactForPath),
          });
          return { value, traceOutput: rawOutput, model, usage };
        }

        const executableCalls = toolCalls
          .filter((call) => call.name === "projectwiki_search" || call.name === "projectwiki_read");
        if (executableCalls.length === 0) {
          const value = parseSearchOutputFromTextBlocks(result.response.content);
          if (!value) {
            await this.appendRetrieverFallbackTrace({
              input,
              rawInput,
              toolEvents,
              started,
              model,
              usage,
              pipeline,
              messages,
              reason: "Retriever response did not include a finish call, executable ProjectWiki tool call, or valid JSON search output.",
            });
            return undefined;
          }
          const selection = validateSearchOutputSelection(
            value,
            catalog,
            this.config.limits.maxSourceCardsPerTurn,
          );
          const selectedPaths = selection.selectedPaths;
          const rawOutput = { ...selection.traceOutput, toolEvents };
          await this.store.appendTrace({
            ...this.traceBase("retrieval", "retriever_finish", input),
            status: selection.value.needsProjectWiki === false || selectedPaths.length === 0 ? "skipped" : "success",
            model,
            durationMs: Date.now() - roundStarted,
            ...traceStep(pipeline, retrieverRoundStepIndex(step, 0), "retriever_finish"),
            input: compactTracePayload({ ...rawInput, toolEvents }),
            output: compactTracePayload(rawOutput),
            rawInput: { ...rawInput, toolEvents },
            rawOutput,
            payloads: {
              modelRequest: result.request,
              modelResponse: result.response,
              parsedOutput: value,
              retrieverMessages: messages,
            },
            usage: result.response.usage,
            artifacts: selectedPaths.map(traceArtifactForPath),
          });
          return { value: selection.value, traceOutput: rawOutput, model, usage };
        }

        const guardReason = retrieverToolGuardReason(executableCalls, {
          searchCallCount,
          readCallCount,
          readPaths,
        });
        if (guardReason) {
          await this.appendRetrieverFallbackTrace({
            input,
            rawInput,
            toolEvents,
            started,
            model,
            usage,
            pipeline,
            messages,
            reason: guardReason,
          });
          return undefined;
        }

        const toolCallOutput = {
          toolCalls: executableCalls.map((call) => ({
            name: call.name,
            input: call.input,
          })),
        };
        this.emitActivity(input, pipeline, {
          phase: "retriever",
          state: "running",
          title: this.outputLanguage === "zh-CN" ? "Retriever 生成了 ProjectWiki 工具调用" : "Retriever generated ProjectWiki tool calls",
          detail: executableCalls.map(formatRetrieverToolCall).join("；"),
          catalog: catalog.map(activityMaterialFromCatalogEntry),
          stats: { catalogCount: catalog.length },
        });
        await this.store.appendTrace({
          ...this.traceBase("retrieval", "retriever_tool_call", input),
          status: "success",
          model,
          durationMs: Date.now() - roundStarted,
          ...traceStep(pipeline, retrieverRoundStepIndex(step, 0), "retriever_tool_call"),
          input: compactTracePayload({ ...rawInput, toolEvents }),
          output: compactTracePayload(toolCallOutput),
          rawInput: { ...rawInput, toolEvents },
          rawOutput: toolCallOutput,
          payloads: {
            modelRequest: result.request,
            modelResponse: result.response,
            retrieverMessages: messages,
          },
          usage: result.response.usage,
        });

        messages.push({
          role: "assistant",
          content: result.response.content,
          metadata: { synthetic: true, purpose: "project_wiki_retriever_tool_call" },
        });

        const toolResults = [];
        for (const call of executableCalls) {
          if (call.name === "projectwiki_search") {
            searchCallCount += 1;
          } else if (call.name === "projectwiki_read") {
            readCallCount += 1;
            const relativePath = isRecord(call.input)
              ? normalizeRetrievableProjectWikiPath(readString(call.input.relativePath))
              : undefined;
            if (relativePath) readPaths.add(relativePath);
          }
          const executed = await this.executeRetrieverTool(
            call,
            catalog,
            input,
            searchInput,
            pipeline,
            retrieverRoundStepIndex(step, 0.1),
          );
          toolEvents.push({
            step,
            name: call.name,
            input: call.input,
            ok: !executed.isError,
            preview: truncateText(JSON.stringify(executed.payload), 700),
          });
          this.emitActivity(input, pipeline, activityFromRetrieverToolResult({
            call,
            payload: executed.payload,
            isError: Boolean(executed.isError),
            catalog,
            outputLanguage: this.outputLanguage,
          }));
          toolResults.push({
            type: "tool_result" as const,
            toolCallId: call.id,
            isError: executed.isError || undefined,
            content: [{
              type: "text" as const,
              text: JSON.stringify(executed.payload, null, 2),
            }],
          });
        }

        messages.push({
          role: "user",
          content: toolResults,
          metadata: { synthetic: true, purpose: "project_wiki_retriever_tool_result" },
        });
      }
      await this.appendRetrieverFallbackTrace({
        input,
        rawInput,
        toolEvents,
        started,
        model,
        usage,
        pipeline,
        messages,
        reason: `Retriever reached the ${RETRIEVER_MAX_STEPS}-step limit without finishing.`,
      });
      return undefined;
    } catch (error) {
      await this.appendRetrieverFallbackTrace({
        input,
        rawInput,
        toolEvents,
        started,
        model,
        usage,
        pipeline,
        messages,
        reason: `Retriever fell back to structured search after an error: ${errorMessage(error)}`,
      });
      return undefined;
    }
  }

  private async appendRetrieverFallbackTrace(input: {
    input: ProjectWikiRetrieveInput;
    rawInput: unknown;
    toolEvents: Array<Record<string, unknown>>;
    started: number;
    model: ProjectWikiModelRef;
    usage?: CanonicalUsage;
    pipeline?: TracePipelineContext;
    messages?: CanonicalMessage[];
    reason: string;
  }): Promise<void> {
    const rawOutput = {
      reason: input.reason,
      toolEvents: input.toolEvents,
    };
    try {
      await this.store.appendTrace({
        ...this.traceBase("retrieval", "retriever_fallback", input.input),
        status: "skipped",
        model: input.model,
        durationMs: Date.now() - input.started,
        ...traceStep(input.pipeline, 2, "retriever_fallback"),
        input: compactTracePayload(input.rawInput),
        output: compactTracePayload(rawOutput),
        rawInput: input.rawInput,
        rawOutput,
        payloads: input.messages ? { retrieverMessages: input.messages } : undefined,
        usage: input.usage,
      });
    } catch {
      // ProjectWiki retrieval should still be able to fall back to structured search.
    }
  }

  private async executeRetrieverTool(
    call: RetrieverToolCall,
    catalog: ProjectWikiCatalogEntry[],
    retrievalInput: ProjectWikiRetrieveInput,
    searchInput: {
      recentMessages: string;
      openConflicts: OpenConflictContext[];
    },
    pipeline?: TracePipelineContext,
    stepIndex = 2.1,
  ): Promise<{ isError?: boolean; payload: unknown }> {
    if (call.name === "projectwiki_search") {
      const input = isRecord(call.input) ? call.input : {};
      const query = readString(input.query);
      const limit = readPositiveInteger(input.limit, this.config.limits.maxSourceCardsPerTurn);
      const toolCatalog = await this.buildModelCatalog(catalog);
      const modelInput = {
        ...this.outputLanguageInput,
        query,
        recentMessages: searchInput.recentMessages,
        catalog: toolCatalog,
        openConflicts: searchInput.openConflicts,
        limit,
        toolRequest: "projectwiki_search",
      };
      const started = Date.now();
      try {
        const result = await this.modelRunner.structured<ProjectWikiSearchOutput>({
          role: "searcher",
          systemPrompt: this.systemPrompt(PROJECT_WIKI_SEARCHER_SYSTEM_PROMPT),
          userPrompt: JSON.stringify(modelInput, null, 2),
          schema: searchOutputSchema,
          schemaName: "project_wiki_tool_catalog_search",
          maxOutputTokens: 2048,
          signal: retrievalInput.signal,
          validate: isSearchOutput,
        });
        const selection = validateSearchOutputSelection(result.value, toolCatalog, limit);
        const selectedPaths = selection.selectedPaths;
        const catalogByPath = new Map(toolCatalog.map((entry) => [entry.relativePath, entry]));
        const payload = {
          query,
          needsProjectWiki: selection.value.needsProjectWiki,
          intent: selection.value.intent,
          notes: selection.value.notes,
          selected: selectedPaths.map((relativePath) => ({
            ...catalogByPath.get(relativePath),
            relativePath,
            reason: selection.value.selected?.find((item) => item.relativePath === relativePath)?.reason,
          })),
          rejected: selection.value.rejected ?? [],
          ...(selection.invalidSelected.length > 0 ? { invalidSelected: selection.invalidSelected } : {}),
        };
        await this.store.appendTrace({
          ...this.traceBase("retrieval", "tool_catalog_search", retrievalInput),
          status: selection.value.needsProjectWiki === false || selectedPaths.length === 0 ? "skipped" : "success",
          model: result.model,
          durationMs: Date.now() - started,
          ...traceStep(pipeline, stepIndex, "tool_catalog_search"),
          input: compactTracePayload(modelInput),
          output: compactTracePayload(payload),
          rawInput: modelInput,
          rawOutput: payload,
          payloads: {
            modelRequest: result.request,
            modelResponse: result.response,
            parsedOutput: result.value,
            businessOutput: payload,
          },
          usage: result.response.usage,
          artifacts: selectedPaths.map(traceArtifactForPath),
        });
        return { payload };
      } catch (error) {
        const message = errorMessage(error);
        await this.store.appendTrace({
          ...this.traceBase("retrieval", "tool_catalog_search_failed", retrievalInput),
          status: "error",
          model: this.modelRunner.resolveModel("searcher"),
          durationMs: Date.now() - started,
          ...traceStep(pipeline, stepIndex, "tool_catalog_search_failed"),
          input: compactTracePayload(modelInput),
          rawInput: modelInput,
          error: message,
          payloads: modelErrorTracePayloads(error),
        });
        return {
          isError: true,
          payload: {
            query,
            error: `ProjectWiki Searcher failed inside projectwiki_search: ${message}`,
          },
        };
      }
    }
    if (call.name === "projectwiki_read") {
      const input = isRecord(call.input) ? call.input : {};
      const relativePath = normalizeRetrievableProjectWikiPath(readString(input.relativePath));
      const maxChars = readPositiveInteger(input.maxChars, this.config.limits.maxMaterialChars);
      if (!relativePath) {
        return {
          isError: true,
          payload: {
            error: "relativePath must be a canonical ProjectWiki wiki page or source card path.",
          },
        };
      }
      const file = await this.store.readRelative(relativePath);
      if (!file) {
        return {
          isError: true,
          payload: { relativePath, error: "ProjectWiki file not found." },
        };
      }
      return {
        payload: {
          relativePath: file.relativePath,
          frontmatter: file.frontmatter,
          content: truncateText(file.content, maxChars),
        },
      };
    }
    return {
      isError: true,
      payload: { error: `Unsupported ProjectWiki retriever tool: ${call.name}` },
    };
  }

  private async buildModelCatalog(catalog: ProjectWikiCatalogEntry[]): Promise<ProjectWikiCatalogEntry[]> {
    const fullCatalog = filterRetrievableCatalog(
      await this.store.listCatalog(Number.MAX_SAFE_INTEGER),
    );
    return mergeCatalogEntries(catalog, fullCatalog);
  }

  async search(input: ProjectWikiSearchInput): Promise<ProjectWikiSearchResult> {
    if (!this.config.enabled) {
      return {
        selected: [],
        rejected: [],
        diagnostics: [{
          code: "project_wiki_disabled",
          severity: "info",
          message: "ProjectWiki is disabled.",
        }],
      };
    }
    await this.store.ensureInitialized();
    const diagnostics: ProjectWikiDiagnostic[] = [];
    const pipeline = this.createTracePipeline("direct_search", input);
    try {
      const catalog = filterRetrievableCatalog(
        await this.store.listCatalog(this.config.limits.maxCatalogChars),
      );
      const modelCatalog = await this.buildModelCatalog(catalog);
      const openConflicts = await this.buildOpenConflictContext(modelCatalog);
      const recent = canonicalMessagesToTextDigest(input.recentMessages, 4_000);
      const searchInput = {
        ...this.outputLanguageInput,
        query: input.query,
        recentMessages: recent,
        catalog: modelCatalog,
        openConflicts,
      };
      const started = Date.now();
      let search: ProjectWikiStructuredCallResult<ProjectWikiSearchOutput>;
      try {
        search = await this.modelRunner.structured<ProjectWikiSearchOutput>({
          role: "searcher",
          systemPrompt: this.systemPrompt(PROJECT_WIKI_SEARCHER_SYSTEM_PROMPT),
          userPrompt: JSON.stringify(searchInput, null, 2),
          schema: searchOutputSchema,
          schemaName: "project_wiki_tool_search",
          maxOutputTokens: 2048,
          signal: input.signal,
          validate: isSearchOutput,
        });
      } catch (error) {
        const message = errorMessage(error);
        await this.store.appendTrace({
          ...this.traceBase("retrieval", "tool_search_failed", input),
          status: "error",
          model: this.modelRunner.resolveModel("searcher"),
          durationMs: Date.now() - started,
          ...traceStep(pipeline, 2, "project_wiki_search"),
          input: compactTracePayload(searchInput),
          rawInput: searchInput,
          error: message,
          payloads: modelErrorTracePayloads(error),
        });
        return {
          selected: [],
          rejected: [],
          diagnostics: [{
            code: "project_wiki_model_error",
            severity: "warning",
            message: `ProjectWiki Searcher failed: ${message}`,
          }],
        };
      }

      const selection = validateSearchOutputSelection(
        search.value,
        modelCatalog,
        input.limit ?? this.config.limits.maxSourceCardsPerTurn,
      );
      const selectedPaths = selection.selectedPaths;
      const catalogByPath = new Map(modelCatalog.map((entry) => [entry.relativePath, entry]));
      await this.store.appendTrace({
        ...this.traceBase("retrieval", "tool_search", input),
        status: selection.value.needsProjectWiki === false || selectedPaths.length === 0 ? "skipped" : "success",
        model: search.model,
        durationMs: Date.now() - started,
        ...traceStep(pipeline, 2, "project_wiki_search"),
        input: compactTracePayload(searchInput),
        output: compactTracePayload(selection.traceOutput),
        rawInput: searchInput,
        rawOutput: selection.traceOutput,
        payloads: {
          ...modelTracePayloads(search),
          businessOutput: selection.traceOutput,
        },
        usage: search.response.usage,
        artifacts: selectedPaths.map(traceArtifactForPath),
      });

      if (selection.value.needsProjectWiki === false || selectedPaths.length === 0) {
        diagnostics.push({
          code: "project_wiki_context_empty",
          severity: "info",
          message: "ProjectWiki Searcher selected no context for this query.",
        });
      }

      return {
        selected: selectedPaths.map((relativePath) => {
          const raw = (search.value.selected ?? []).find((item) => item.relativePath === relativePath);
          const catalogEntry = catalogByPath.get(relativePath);
          return {
            relativePath,
            reason: raw?.reason,
            priority: raw?.priority,
            title: catalogEntry?.title,
            kind: catalogEntry?.kind,
            sourceType: catalogEntry?.sourceType,
            status: catalogEntry?.status,
            statusReason: catalogEntry?.statusReason,
            sourceHealth: catalogEntry?.sourceHealth,
            preview: catalogEntry?.preview,
          };
        }),
        rejected: (selection.value.rejected ?? [])
          .map((item) => ({
            relativePath: typeof item.relativePath === "string" ? item.relativePath : "",
            reason: item.reason,
          }))
          .filter((item) => item.relativePath.length > 0),
        needsProjectWiki: selection.value.needsProjectWiki,
        intent: selection.value.intent,
        notes: selection.value.notes,
        diagnostics,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.store.appendTrace({
        ...this.traceBase("retrieval", "tool_search_store_failed", input),
        status: "error",
        ...traceStep(pipeline, 99, "project_wiki_search_failed"),
        error: message,
      });
      return {
        selected: [],
        rejected: [],
        diagnostics: [{
          code: "project_wiki_store_error",
          severity: "warning",
          message: `ProjectWiki search failed: ${message}`,
        }],
      };
    }
  }

  private async buildOpenConflictContext(catalog: ProjectWikiCatalogEntry[]): Promise<OpenConflictContext[]> {
    const sourcePathById = new Map<string, string>();
    for (const entry of catalog) {
      if (entry.kind === "source_card" && entry.sourceCardId) {
        sourcePathById.set(entry.sourceCardId, entry.relativePath);
      }
    }
    const conflicts = await this.store.readConflicts(40);
    return conflicts
      .filter((conflict) => conflict.status !== "resolved")
      .slice(0, 20)
      .map((conflict) => normalizeOpenConflictForModel(conflict, sourcePathById));
  }

  async read(input: ProjectWikiReadInput): Promise<ProjectWikiReadResult | undefined> {
    if (!this.config.enabled) return undefined;
    await this.store.ensureInitialized();
    const relativePath = normalizeRetrievableProjectWikiPath(input.relativePath);
    if (!relativePath) return undefined;
    const file = await this.store.readRelative(relativePath);
    if (!file) return undefined;
    return {
      relativePath: file.relativePath,
      content: truncateText(file.content, input.maxChars ?? this.config.limits.maxMaterialChars),
      frontmatter: file.frontmatter,
    };
  }

  async captureTurn(input: ProjectWikiCaptureTurnInput): Promise<void> {
    if (!this.config.enabled) return;
    await this.store.ensureInitialized();
    const captureInput: QueuedProjectWikiCaptureInput = {
      ...input,
      messages: [...input.messages],
      tracePipeline: this.createTracePipeline("ingestion", input),
    };
    this.indexingQueue = this.indexingQueue
      .catch(() => undefined)
      .then(async () => {
        await this.processCaptureTurn(captureInput);
      })
      .catch(async (error) => {
        try {
          await this.store.appendTrace({
            ...this.traceBase("index", "capture_queue_failed", captureInput),
            status: "error",
            ...traceStep(captureInput.tracePipeline, 99, "capture_queue_failed"),
            error: errorMessage(error),
          });
        } catch {
          // Capture runs after the user-visible turn; failures must stay isolated.
        }
      });
  }

  async refresh(input: ProjectWikiRefreshInput = {}): Promise<ProjectWikiRefreshResult> {
    if (!this.config.enabled) {
      return {
        refreshed: false,
        diagnostics: [{
          code: "project_wiki_disabled",
          severity: "info",
          message: "ProjectWiki is disabled.",
        }],
      };
    }
    await this.store.ensureInitialized();
    const now = this.now().toISOString();
    const refreshInput: QueuedProjectWikiCaptureInput = {
      sessionId: input.sessionId ?? "__projectwiki_refresh__",
      turnId: input.turnId ?? `manual-${timestampSlug(now)}`,
      projectRoot: this.projectRoot,
      messages: [],
      errored: false,
      recheckStaleSources: true,
    };
    refreshInput.tracePipeline = this.createTracePipeline("refresh", refreshInput);
    const current = await this.processCaptureTurn(refreshInput);
    const history = await this.backfillHistoricalTurns(refreshInput, input.maxHistoricalTurns);
    await this.flushMaintenance();
    return {
      refreshed: true,
      diagnostics: [],
      maxHistoricalTurns: history.maxHistoricalTurns,
      indexedTurns: history.indexedTurns,
      skippedTurns: history.skippedTurns,
      failedTurns: history.failedTurns,
      scannedTranscripts: history.scannedTranscripts,
      discoveredTurns: history.discoveredTurns,
      sourceCardsCreated: current.sourceCardsCreated + history.sourceCardsCreated,
      sourceCardsReconciled: current.sourceCardsReconciled,
    };
  }

  async flushMaintenance(): Promise<void> {
    await this.indexingQueue;
    await this.maintenanceQueue;
  }

  private async processCaptureTurn(input: QueuedProjectWikiCaptureInput): Promise<ProcessCaptureTurnResult> {
    await this.store.ensureInitialized();
    try {
      const createdCards: ProjectWikiSourceCardRecord[] = [];
      let sourceCardsCreated = 0;
      let sourceCardsReconciled = 0;
      if (this.config.sources.repo) {
        const repoCards = await this.ensureRepoIndexed(input, input.repoMaterial);
        sourceCardsCreated += repoCards.length;
        createdCards.push(...repoCards);
      }
      const reconciledCards = await this.reconcileSourceChanges(input, {
        includeStale: input.recheckStaleSources === true,
      });
      sourceCardsReconciled += reconciledCards.length;
      createdCards.push(...reconciledCards);
      if (this.config.sources.memory) {
        const legacyCards = await this.ensureLegacyMemoryImported(input);
        sourceCardsCreated += legacyCards.length;
        createdCards.push(...legacyCards);
      }
      const turnIndex = await this.indexTurn(input);
      sourceCardsCreated += turnIndex.cards.length;
      createdCards.push(...turnIndex.cards);
      if (createdCards.length > 0) {
        await this.store.enqueueMaintenanceCards(createdCards, input);
      }
      if (createdCards.length > 0 || await this.store.hasPendingMaintenanceCards()) {
        this.scheduleWikiMaintenance(input);
      }
      return { cards: createdCards, sourceCardsCreated, sourceCardsReconciled };
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("index", "capture_failed", input),
        status: "error",
        ...traceStep(input.tracePipeline, 99, "capture_failed"),
        error: error instanceof Error ? error.message : String(error),
      });
      return { cards: [], sourceCardsCreated: 0, sourceCardsReconciled: 0 };
    }
  }

  private async backfillHistoricalTurns(
    input: TraceableProjectWikiCaptureInput,
    maxHistoricalTurns?: number,
  ): Promise<HistoryBackfillResult> {
    const started = Date.now();
    const maxTurns = normalizePositiveLimit(maxHistoricalTurns, HISTORY_BACKFILL_MAX_TURNS);
    const chatDir = this.chatDir ?? resolve(this.store.rootDir, "..", "chats");
    const result: HistoryBackfillResult = {
      maxHistoricalTurns: maxTurns,
      scannedTranscripts: 0,
      discoveredTurns: 0,
      indexedTurns: 0,
      skippedTurns: 0,
      failedTurns: 0,
      sourceCardsCreated: 0,
    };

    if (!this.config.sources.conversations && !this.config.sources.knowledge) {
      await this.store.appendTrace({
        ...this.traceBase("index", "history_backfill", input),
        status: "skipped",
        ...traceStep(input.tracePipeline, 5, "history_backfill"),
        input: { chatDir, maxTurns, reason: "Conversation and knowledge sources are disabled." },
        output: result,
      });
      return result;
    }

    let turns: HistoricalTurnMaterial[];
    try {
      const collected = await collectHistoricalTurnMaterials({
        chatDir,
        projectRoot: this.projectRoot,
        maxTranscripts: HISTORY_BACKFILL_MAX_TRANSCRIPTS,
        maxTurns,
      });
      result.scannedTranscripts = collected.scannedTranscripts;
      turns = collected.turns;
      result.discoveredTurns = turns.length;
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("index", "history_backfill_failed", input),
        status: "error",
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 5, "history_backfill_failed"),
        input: { chatDir, maxTurns },
        error: errorMessage(error),
      });
      return result;
    }

    if (turns.length === 0) {
      await this.store.appendTrace({
        ...this.traceBase("index", "history_backfill", input),
        status: "skipped",
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 5, "history_backfill"),
        input: { chatDir, maxTurns },
        output: result,
      });
      return result;
    }

    const state = await this.readHistoryBackfillState();
    const createdCards: ProjectWikiSourceCardRecord[] = [];
    for (const turn of turns) {
      const key = historyTurnStateKey(turn);
      if (state.turns[key]?.contentHash === turn.contentHash) {
        result.skippedTurns += 1;
        continue;
      }
      const indexed = await this.indexTurn({ ...turn, tracePipeline: input.tracePipeline });
      if (indexed.status === "error") {
        result.failedTurns += 1;
        continue;
      }
      result.indexedTurns += indexed.status === "success" ? 1 : 0;
      result.skippedTurns += indexed.status === "skipped" ? 1 : 0;
      result.sourceCardsCreated += indexed.cards.length;
      createdCards.push(...indexed.cards);
      state.turns[key] = {
        contentHash: turn.contentHash,
        indexedAt: this.now().toISOString(),
        transcriptPath: turn.transcriptPath,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
      };
    }

    await this.writeHistoryBackfillState(pruneHistoryBackfillState(state, turns));
    if (createdCards.length > 0) {
      await this.store.enqueueMaintenanceCards(createdCards, input);
      this.scheduleWikiMaintenance(input);
    }
    await this.store.appendTrace({
      ...this.traceBase("index", "history_backfill", input),
      status: result.indexedTurns > 0 || result.sourceCardsCreated > 0 ? "success" : "skipped",
      durationMs: Date.now() - started,
      ...traceStep(input.tracePipeline, 5, "history_backfill"),
      input: compactTracePayload({ chatDir, maxTurns }),
      output: compactTracePayload(result),
      rawInput: { chatDir, maxTurns },
      rawOutput: result,
      artifacts: createdCards.map((card) => ({
        kind: "source_card" as const,
        id: card.id,
        path: card.relativePath,
        title: card.title,
      })),
    });
    return result;
  }

  private async indexTurn(input: TraceableProjectWikiCaptureInput): Promise<IndexTurnResult> {
    const turnSourceTypes = enabledTurnSourceTypes(this.config);
    if (turnSourceTypes.length === 0) return { cards: [], status: "skipped" };
    const digest = canonicalMessagesToTextDigest(input.messages, 16_000);
    if (!digest.trim()) return { cards: [], status: "skipped" };
    const sourceRefs = buildTurnSourceRefs(input, digest);
    const modelInput = {
      ...this.outputLanguageInput,
      materialType: "turn_messages",
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
      turnId: input.turnId,
      errored: input.errored,
      enabledSourceTypes: turnSourceTypes,
      sourceRefs,
      messages: digest,
    };
    const started = Date.now();
    try {
      const result = await this.modelRunner.structured<ProjectWikiIndexOutput>({
        role: "indexer",
        systemPrompt: this.systemPrompt(PROJECT_WIKI_INDEXER_SYSTEM_PROMPT),
        userPrompt: JSON.stringify(modelInput, null, 2),
        schema: indexOutputSchema,
        schemaName: "project_wiki_index",
        maxOutputTokens: 4096,
        validate: isIndexOutput,
      });
      const fallbackSourceType = turnSourceTypes.includes("conversations") ? "conversations" : turnSourceTypes[0];
      const cards = await this.persistIndexCards(result.value, sourceRefs, fallbackSourceType, turnSourceTypes);
      await this.store.appendTrace({
        ...this.traceBase("index", "turn", input),
        status: "success",
        model: result.model,
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 4, "index_turn"),
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        rawInput: modelInput,
        rawOutput: result.value,
        payloads: modelTracePayloads(result),
        usage: result.response.usage,
        artifacts: cards.map((card) => ({
          kind: "source_card",
          id: card.id,
          path: card.relativePath,
          title: card.title,
        })),
      });
      return { cards, status: "success" };
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("index", "turn_failed", input),
        status: "error",
        model: this.modelRunner.resolveModel("indexer"),
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 4, "index_turn_failed"),
        input: compactTracePayload(modelInput),
        rawInput: modelInput,
        error: errorMessage(error),
        payloads: modelErrorTracePayloads(error),
      });
      return { cards: [], status: "error" };
    }
  }

  private async ensureRepoIndexed(
    input: TraceableProjectWikiCaptureInput,
    repoMaterial?: RepoDigestMaterial,
  ): Promise<ProjectWikiSourceCardRecord[]> {
    const material = repoMaterial ?? await this.repoDigestBuilder(this.projectRoot);
    const digest = material.digest;
    if (!digest.trim()) {
      await this.store.appendTrace({
        ...this.traceBase("index", "repo", input),
        status: "skipped",
        ...traceStep(input.tracePipeline, 1, "repo_index"),
        input: { reason: "No readable repository digest material." },
      });
      return [];
    }
    const digestHash = hashText(digest);
    const repoState = await this.readRepoDigestState();
    const hasRepoCards = await this.store.hasSourceCards("repo");
    if (hasRepoCards && !repoState) {
      await this.writeRepoDigestState({ contentHash: digestHash, indexedAt: this.now().toISOString() });
      return [];
    }
    if (hasRepoCards && repoState?.contentHash === digestHash) return [];
    const sourceRefs: ProjectWikiSourceRef[] = material.sourceRefs.length > 0
      ? material.sourceRefs
      : [{
        kind: "repo",
        label: this.projectRoot,
        path: this.projectRoot,
        contentHash: digestHash,
      }];
    const modelInput = {
      ...this.outputLanguageInput,
      materialType: "repo_digest",
      projectRoot: this.projectRoot,
      enabledSourceTypes: ["repo"],
      sourceRefs,
      files: material.files,
      digest,
    };
    const started = Date.now();
    try {
      const result = await this.modelRunner.structured<ProjectWikiIndexOutput>({
        role: "indexer",
        systemPrompt: this.systemPrompt(PROJECT_WIKI_INDEXER_SYSTEM_PROMPT),
        userPrompt: JSON.stringify(modelInput, null, 2),
        schema: indexOutputSchema,
        schemaName: "project_wiki_repo_index",
        maxOutputTokens: 4096,
        validate: isIndexOutput,
      });
      const cards = await this.persistIndexCards(result.value, sourceRefs, "repo", ["repo"]);
      await this.writeRepoDigestState({ contentHash: digestHash, indexedAt: this.now().toISOString() });
      await this.store.appendTrace({
        ...this.traceBase("index", "repo", input),
        status: "success",
        model: result.model,
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 1, "repo_index"),
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        rawInput: modelInput,
        rawOutput: result.value,
        payloads: modelTracePayloads(result),
        usage: result.response.usage,
        artifacts: cards.map((card) => ({
          kind: "source_card",
          id: card.id,
          path: card.relativePath,
          title: card.title,
        })),
      });
      return cards;
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("index", "repo_failed", input),
        status: "error",
        model: this.modelRunner.resolveModel("indexer"),
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 1, "repo_index_failed"),
        input: compactTracePayload(modelInput),
        rawInput: modelInput,
        error: errorMessage(error),
        payloads: modelErrorTracePayloads(error),
      });
      return [];
    }
  }

  private async ensureLegacyMemoryImported(input: TraceableProjectWikiCaptureInput): Promise<ProjectWikiSourceCardRecord[]> {
    if (!this.legacyMemoryRootDir) return [];
    const legacyFiles = await collectLegacyMemoryMarkdown(this.legacyMemoryRootDir, this.projectRoot);
    const sourceHash = legacyMemorySourceHash(legacyFiles);
    const previousState = await this.readLegacyMemoryMigrationState();
    if (
      previousState
      && previousState.sourceHash === sourceHash
      && (previousState.status === "completed" || previousState.status === "skipped")
    ) {
      return [];
    }

    const startedAt = this.now().toISOString();
    if (legacyFiles.length === 0) {
      await this.writeLegacyMemoryMigrationState({
        version: LEGACY_MEMORY_MIGRATION_STATE_VERSION,
        status: "skipped",
        projectRoot: this.projectRoot,
        sourceRoot: resolve(this.legacyMemoryRootDir),
        sourceHash,
        sourceFiles: 0,
        sourceCardIds: [],
        sourceCardPaths: [],
        createdSourceCards: 0,
        startedAt,
        completedAt: this.now().toISOString(),
      });
      return [];
    }
    const sourceRefs: ProjectWikiSourceRef[] = legacyFiles.map((file) => ({
      kind: "legacy_memory",
      label: basename(file.path),
      path: file.path,
      contentHash: file.contentHash,
      range: {
        startLine: 1,
        endLine: file.lineCount,
      },
    }));
    const modelInput = {
      ...this.outputLanguageInput,
      materialType: "legacy_memory_migration",
      projectRoot: this.projectRoot,
      sourceRoot: resolve(this.legacyMemoryRootDir),
      sourceHash,
      enabledSourceTypes: ["memory"],
      files: legacyFiles.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        lineCount: file.lineCount,
        content: truncateText(file.content, 4_000),
      })),
    };
    const started = Date.now();
    try {
      const result = await this.modelRunner.structured<ProjectWikiIndexOutput>({
        role: "indexer",
        systemPrompt: this.systemPrompt(PROJECT_WIKI_INDEXER_SYSTEM_PROMPT),
        userPrompt: JSON.stringify(modelInput, null, 2),
        schema: indexOutputSchema,
        schemaName: "project_wiki_legacy_memory_index",
        maxOutputTokens: 4096,
        validate: isIndexOutput,
      });
      const cards = await this.persistIndexCards(result.value, sourceRefs, "memory", ["memory"]);
      await this.writeLegacyMemoryMigrationState({
        version: LEGACY_MEMORY_MIGRATION_STATE_VERSION,
        status: "completed",
        projectRoot: this.projectRoot,
        sourceRoot: resolve(this.legacyMemoryRootDir),
        sourceHash,
        sourceFiles: legacyFiles.length,
        sourceCardIds: cards.map((card) => card.id),
        sourceCardPaths: cards.map((card) => card.relativePath),
        createdSourceCards: cards.length,
        startedAt,
        completedAt: this.now().toISOString(),
      });
      await this.store.appendTrace({
        ...this.traceBase("index", "legacy_memory_migration", input),
        status: "success",
        model: result.model,
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 3, "legacy_memory_import"),
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        rawInput: modelInput,
        rawOutput: result.value,
        payloads: modelTracePayloads(result),
        usage: result.response.usage,
        artifacts: cards.map((card) => ({
          kind: "source_card",
          id: card.id,
          path: card.relativePath,
          title: card.title,
        })),
      });
      return cards;
    } catch (error) {
      const message = errorMessage(error);
      await this.writeLegacyMemoryMigrationState({
        version: LEGACY_MEMORY_MIGRATION_STATE_VERSION,
        status: "error",
        projectRoot: this.projectRoot,
        sourceRoot: resolve(this.legacyMemoryRootDir),
        sourceHash,
        sourceFiles: legacyFiles.length,
        sourceCardIds: [],
        sourceCardPaths: [],
        createdSourceCards: 0,
        startedAt,
        completedAt: this.now().toISOString(),
        error: message,
      });
      await this.store.appendTrace({
        ...this.traceBase("index", "legacy_memory_migration_failed", input),
        status: "error",
        model: this.modelRunner.resolveModel("indexer"),
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 3, "legacy_memory_import_failed"),
        input: compactTracePayload(modelInput),
        rawInput: modelInput,
        error: message,
        payloads: modelErrorTracePayloads(error),
      });
      return [];
    }
  }

  private async persistIndexCards(
    output: ProjectWikiIndexOutput,
    fallbackSourceRefs: ProjectWikiSourceRef[],
    fallbackSourceType: ProjectWikiSourceType,
    allowedSourceTypes: ProjectWikiSourceType[],
  ): Promise<ProjectWikiSourceCardRecord[]> {
    const cards: ProjectWikiSourceCardRecord[] = [];
    for (const draft of output.cards ?? []) {
      const normalized = normalizeSourceCardDraft(draft, fallbackSourceRefs, fallbackSourceType, allowedSourceTypes);
      if (!normalized) continue;
      cards.push(await this.store.writeSourceCard(normalized));
    }
    return cards;
  }

  private async maintainWiki(input: TraceableProjectWikiCaptureInput): Promise<boolean> {
    const pendingCards = await this.store.readPendingMaintenanceCards(
      Math.max(this.config.limits.maxSourceCardsPerTurn, 12),
    );
    if (pendingCards.length === 0) return false;
    const home = await this.store.readRelative("home.md");
    const wikiPages = await this.store.readWikiPages();
    const maintainablePages = [
      ...(home ? [home] : []),
      ...wikiPages,
    ];
    const modelInput = {
      ...this.outputLanguageInput,
      projectRoot: this.projectRoot,
      wikiPages: maintainablePages.map((page) => ({
        relativePath: page.relativePath,
        frontmatter: page.frontmatter,
        content: truncateText(page.content, 6_000),
      })),
      newSourceCards: pendingCards.map((card) => ({
        id: card.id,
        relativePath: card.relativePath,
        sourceType: card.sourceType,
        title: card.title,
        description: card.description,
        summary: card.summary,
        sourceRefs: card.sourceRefs,
        status: card.status,
        statusReason: card.statusReason,
        evidenceLevel: card.evidenceLevel,
        confidence: card.confidence,
        qualitySignals: card.qualitySignals,
      })),
      allowedPageIds: PROJECT_WIKI_MAINTAINABLE_PAGE_IDS,
    };
    const started = Date.now();
    const traceCreatedAt = this.now().toISOString();
    const traceId = this.store.createTraceId(traceCreatedAt);
    try {
      const result = await this.modelRunner.structured<ProjectWikiMaintainOutput>({
        role: "maintainer",
        systemPrompt: this.systemPrompt(PROJECT_WIKI_MAINTAINER_SYSTEM_PROMPT),
        userPrompt: JSON.stringify(modelInput, null, 2),
        schema: maintainOutputSchema,
        schemaName: "project_wiki_maintain",
        maxOutputTokens: 8192,
        validate: isMaintainOutput,
      });
      const updated = [];
      const fallbackSourceCardIds = pendingCards.map((card) => card.id);
      for (const page of result.value.pages ?? []) {
        const normalized = normalizePageDraft(page, fallbackSourceCardIds);
        if (!normalized) continue;
        updated.push(await this.store.writeWikiPage(normalized));
      }
      const conflicts = await this.store.appendConflicts(result.value.conflicts ?? [], traceId);
      await this.store.appendTrace({
        id: traceId,
        createdAt: traceCreatedAt,
        ...this.traceBase("maintain", "wiki", input),
        status: updated.length > 0 || conflicts.length > 0 ? "success" : "skipped",
        model: result.model,
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 6, "maintain_wiki"),
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        rawInput: modelInput,
        rawOutput: result.value,
        payloads: modelTracePayloads(result),
        usage: result.response.usage,
        artifacts: [
          ...updated.map((page) => ({
            kind: "wiki_page" as const,
            path: page.relativePath,
            id: page.pageId,
            title: page.title,
          })),
          ...conflicts.map((conflict) => ({
            kind: "conflict" as const,
            id: conflict.id,
            title: conflict.topic,
          })),
        ],
      });
      await this.store.markMaintenanceCardsProcessed(pendingCards, traceId);
      return true;
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("maintain", "wiki_failed", input),
        status: "error",
        model: this.modelRunner.resolveModel("maintainer"),
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, 6, "maintain_wiki_failed"),
        input: compactTracePayload(modelInput),
        rawInput: modelInput,
        error: errorMessage(error),
        payloads: modelErrorTracePayloads(error),
      });
      return false;
    }
  }

  private scheduleWikiMaintenance(input: TraceableProjectWikiCaptureInput): void {
    const maintenanceInput = { ...input };
    this.maintenanceQueue = this.maintenanceQueue
      .then(async () => {
        for (let batch = 0; batch < 5; batch += 1) {
          const processed = await this.maintainWiki(maintenanceInput);
          if (!processed) return;
        }
        if (await this.store.hasPendingMaintenanceCards()) {
          await this.store.appendTrace({
            ...this.traceBase("maintain", "wiki_backlog_deferred", maintenanceInput),
            status: "skipped",
            ...traceStep(maintenanceInput.tracePipeline, 7, "maintenance_deferred"),
            input: { reason: "Maintenance backlog still has pending source cards after batch limit." },
          });
        }
      })
      .catch(async (error) => {
        await this.store.appendTrace({
          ...this.traceBase("maintain", "wiki_queue_failed", maintenanceInput),
          status: "error",
          ...traceStep(maintenanceInput.tracePipeline, 99, "maintenance_queue_failed"),
          error: errorMessage(error),
        });
      });
  }

  private async reconcileSourceChanges(
    input: { sessionId?: string; turnId?: string; tracePipeline?: TracePipelineContext },
    options: { includeStale?: boolean } = {},
    stepIndex = 2,
    stepName = "reconcile_source_changes",
  ): Promise<ProjectWikiSourceCardRecord[]> {
    const started = Date.now();
    try {
      const changes = await this.store.observeSourceCardChanges({ includeStale: options.includeStale });
      if (changes.length === 0) return [];
      const modelInput = {
        ...this.outputLanguageInput,
        projectRoot: this.projectRoot,
        changes: changes.map(sourceChangeForModel),
      };
      const result = await this.modelRunner.structured<ProjectWikiSourceReconcileOutput>({
        role: "maintainer",
        systemPrompt: this.systemPrompt(PROJECT_WIKI_RECONCILER_SYSTEM_PROMPT),
        userPrompt: JSON.stringify(modelInput, null, 2),
        schema: sourceReconcileOutputSchema,
        schemaName: "project_wiki_source_reconcile",
        maxOutputTokens: 4096,
        validate: isSourceReconcileOutput,
      });
      const traceCreatedAt = this.now().toISOString();
      const traceId = this.store.createTraceId(traceCreatedAt);
      const applied = await this.applySourceReconcileDecisions(changes, result.value, traceId);
      await this.store.appendTrace({
        id: traceId,
        createdAt: traceCreatedAt,
        ...this.traceBase("maintain", "source_reconcile", input),
        status: applied.updated.length > 0 || applied.conflicts.length > 0 ? "success" : "skipped",
        model: result.model,
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, stepIndex, stepName),
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        rawInput: modelInput,
        rawOutput: result.value,
        payloads: modelTracePayloads(result),
        usage: result.response.usage,
        artifacts: [
          ...applied.updated.map((card) => ({
            kind: "source_card" as const,
            id: card.id,
            path: card.relativePath,
            title: card.title,
          })),
          ...applied.conflicts.map((conflict) => ({
            kind: "conflict" as const,
            id: conflict.id,
            title: conflict.topic,
          })),
        ],
      });
      return applied.updated;
    } catch (error) {
      await this.store.appendTrace({
        ...this.traceBase("maintain", "source_reconcile_failed", input),
        status: "error",
        model: this.modelRunner.resolveModel("maintainer"),
        durationMs: Date.now() - started,
        ...traceStep(input.tracePipeline, stepIndex, `${stepName}_failed`),
        error: errorMessage(error),
        payloads: modelErrorTracePayloads(error),
      });
      return [];
    }
  }

  private async applySourceReconcileDecisions(
    changes: ProjectWikiSourceChangeEvent[],
    output: ProjectWikiSourceReconcileOutput,
    traceId: string,
  ): Promise<{ updated: ProjectWikiSourceCardRecord[]; conflicts: ProjectWikiConflictRecord[] }> {
    const changesById = new Map(changes.map((event) => [event.sourceCardId, event]));
    const changesByPath = new Map(changes.map((event) => [event.relativePath, event]));
    const updated: ProjectWikiSourceCardRecord[] = [];
    const conflictDrafts: Array<{ topic?: string; summary?: string; sourceCardIds?: string[] }> = [];
    for (const decision of output.decisions ?? []) {
      const event = (decision.sourceCardId ? changesById.get(decision.sourceCardId) : undefined)
        ?? (decision.relativePath ? changesByPath.get(decision.relativePath) : undefined);
      if (!event) continue;
      const next = sourceCardForReconcileDecision(event, decision);
      if (!next) continue;
      updated.push(await this.store.updateSourceCardRecord(next));
      if (decision.outcome === "conflict") {
        const conflictSourceCardIds = readStringArray(decision.conflict?.sourceCardIds);
        conflictDrafts.push(decision.conflict ? {
          ...decision.conflict,
          sourceCardIds: conflictSourceCardIds.length > 0 ? conflictSourceCardIds : [next.id],
        } : {
          topic: next.title,
          summary: decision.statusReason ?? "Source evidence conflicts with this ProjectWiki source card.",
          sourceCardIds: [next.id],
        });
      }
    }
    const conflicts = await this.store.appendConflicts(conflictDrafts, traceId);
    return { updated, conflicts };
  }
}

function traceBase(
  kind: ModelTraceBase["kind"],
  phase: string,
  projectRoot: string,
  input: { sessionId?: string; turnId?: string },
  language?: ProjectWikiPromptLanguage,
): ModelTraceBase {
  return {
    kind,
    phase,
    projectRoot,
    sessionId: input.sessionId,
    turnId: input.turnId,
    language,
  };
}

function traceStep(
  pipeline: TracePipelineContext | undefined,
  stepIndex: number,
  stepName: string,
): Pick<ProjectWikiTraceRecord, "pipelineRunId" | "pipelineKind" | "stepIndex" | "stepName"> {
  return {
    ...(pipeline ? {
      pipelineRunId: pipeline.pipelineRunId,
      pipelineKind: pipeline.pipelineKind,
    } : {}),
    stepIndex,
    stepName,
  };
}

function retrieverRoundStepIndex(step: number, offset = 0): number {
  return 2 + (step * 0.3) + offset;
}

function modelTracePayloads<T>(result: ProjectWikiStructuredCallResult<T>): {
  modelRequest: unknown;
  modelResponse: unknown;
  parsedOutput: unknown;
} {
  return {
    modelRequest: result.request,
    modelResponse: result.response,
    parsedOutput: result.value,
  };
}

function modelErrorTracePayloads(error: unknown): { modelRequest?: unknown } | undefined {
  const request = projectWikiModelRequestFromError(error);
  return request ? { modelRequest: request } : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function compactTracePayload(value: unknown, keyHint = "", depth = 0): unknown {
  if (typeof value === "string") {
    const limit = isLargeTraceField(keyHint) ? TRACE_FIELD_PREVIEW_CHARS : TRACE_PREVIEW_CHARS;
    return compactTraceString(value, limit);
  }
  if (Array.isArray(value)) {
    if (keyHint === "catalog") return compactCatalogEntries(value);
    if (keyHint === "materials" || keyHint === "wikiPages") return compactMaterialEntries(value);
    if (keyHint === "files") return compactFileEntries(value);
    if (keyHint === "newSourceCards") return compactSourceCardEntries(value);
    const rows = value
      .slice(0, TRACE_ARRAY_LIMIT)
      .map((item) => compactTracePayload(item, keyHint, depth + 1));
    if (value.length > TRACE_ARRAY_LIMIT) {
      rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
    }
    return rows;
  }
  if (!isRecord(value)) return value;
  if (depth > 6) {
    return { compacted: true, reason: "maximum trace depth reached" };
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = compactTracePayload(nested, key, depth + 1);
  }
  return output;
}

function compactCatalogEntries(value: unknown[]): unknown[] {
  const rows = value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!isRecord(item)) return item;
    return {
      relativePath: readString(item.relativePath),
      kind: readString(item.kind),
      sourceCardId: readString(item.sourceCardId),
      sourceType: readString(item.sourceType),
      title: readString(item.title),
      description: compactTraceString(readString(item.description), 220),
      updatedAt: readString(item.updatedAt),
      evidenceLevel: readString(item.evidenceLevel),
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      qualitySignals: item.qualitySignals,
      tags: item.tags,
      preview: compactTraceString(readString(item.preview), 240),
    };
  });
  if (value.length > TRACE_ARRAY_LIMIT) rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
  return rows;
}

function normalizeOpenConflictForModel(
  conflict: ProjectWikiConflictRecord,
  sourcePathById: Map<string, string>,
): {
  id: string;
  topic: string;
  summary: string;
  sourceCardIds: string[];
  sourcePaths: string[];
  traceId?: string;
  updatedAt?: string;
} {
  const sourceCardIds = Array.isArray(conflict.sourceCardIds)
    ? conflict.sourceCardIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
  return {
    id: conflict.id,
    topic: conflict.topic,
    summary: conflict.summary,
    sourceCardIds,
    sourcePaths: sourceCardIds
      .map((id) => sourcePathById.get(id))
      .filter((path): path is string => Boolean(path)),
    traceId: conflict.traceId,
    updatedAt: conflict.updatedAt,
  };
}

function compactMaterialEntries(value: unknown[]): unknown[] {
  const rows = value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!isRecord(item)) return item;
        return {
          relativePath: readString(item.relativePath),
          frontmatter: compactTracePayload(item.frontmatter, "frontmatter", 1),
          catalog: compactTracePayload(item.catalog, "catalogEntry", 1),
          content: compactTraceString(readString(item.content), 360),
        };
      });
  if (value.length > TRACE_ARRAY_LIMIT) rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
  return rows;
}

function compactFileEntries(value: unknown[]): unknown[] {
  const rows = value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!isRecord(item)) return item;
    return {
      path: readString(item.path),
      content: compactTraceString(readString(item.content), 240),
    };
  });
  if (value.length > TRACE_ARRAY_LIMIT) rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
  return rows;
}

function compactSourceCardEntries(value: unknown[]): unknown[] {
  const rows = value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!isRecord(item)) return item;
    return {
      id: readString(item.id),
      relativePath: readString(item.relativePath),
      sourceType: readString(item.sourceType),
      title: readString(item.title),
      description: compactTraceString(readString(item.description), 220),
      summary: compactTraceString(readString(item.summary), 360),
      status: readString(item.status),
      statusReason: compactTraceString(readString(item.statusReason), 220),
      evidenceLevel: readString(item.evidenceLevel),
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      qualitySignals: item.qualitySignals,
      sourceRefs: compactTracePayload(item.sourceRefs, "sourceRefs", 1),
    };
  });
  if (value.length > TRACE_ARRAY_LIMIT) rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
  return rows;
}

function compactTraceString(value: string, limit: number): unknown {
  if (value.length <= limit) return value;
  return {
    preview: truncateText(value, limit),
    chars: value.length,
    truncated: true,
  };
}

function isLargeTraceField(key: string): boolean {
  return [
    "content",
    "digest",
    "messages",
    "recentMessages",
    "summary",
    "excerpt",
    "body",
  ].includes(key);
}

function enabledSourceTypes(config: ProjectWikiRuntimeConfig): ProjectWikiSourceType[] {
  return PROJECT_WIKI_SOURCE_TYPES.filter((type) => config.sources[type]);
}

function enabledTurnSourceTypes(config: ProjectWikiRuntimeConfig): ProjectWikiSourceType[] {
  return (["conversations", "knowledge"] as ProjectWikiSourceType[])
    .filter((type) => config.sources[type]);
}

function sourceChangeForModel(event: ProjectWikiSourceChangeEvent): Record<string, unknown> {
  const card = event.sourceCard;
  return {
    sourceCard: {
      id: card.id,
      relativePath: card.relativePath,
      sourceType: card.sourceType,
      title: card.title,
      description: card.description,
      summary: card.summary,
      status: card.status,
      statusReason: card.statusReason,
      evidenceLevel: card.evidenceLevel,
      confidence: card.confidence,
      qualitySignals: card.qualitySignals,
      sourceRefs: card.sourceRefs,
    },
    observedAt: event.observedAt,
    changes: event.changes.map((change) => ({
      kind: change.kind,
      reason: change.reason,
      sourceRef: change.sourceRef,
      currentSourceRef: change.currentSourceRef,
      currentEvidence: change.currentEvidence ? truncateText(change.currentEvidence, 6_000) : undefined,
    })),
    suggestedSourceRefs: event.suggestedSourceRefs,
  };
}

function sourceCardForReconcileDecision(
  event: ProjectWikiSourceChangeEvent,
  decision: NonNullable<ProjectWikiSourceReconcileOutput["decisions"]>[number],
): ProjectWikiSourceCardRecord | undefined {
  const outcome = decision.outcome;
  if (!outcome) return undefined;
  const card = event.sourceCard;
  const decisionRefs = Array.isArray(decision.sourceRefs)
    ? decision.sourceRefs.map(normalizeSourceRef).filter((ref): ref is ProjectWikiSourceRef => Boolean(ref))
    : [];
  const refreshedRefs = decisionRefs.length > 0 ? decisionRefs : event.suggestedSourceRefs;
  const statusReason = optionalString(decision.statusReason);
  if (outcome === "no_impact" || outcome === "refresh_evidence") {
    return {
      ...card,
      sourceRefs: refreshedRefs,
      status: card.status === "draft" ? "draft" : "active",
      statusReason: card.status === "draft" ? card.statusReason : undefined,
    };
  }
  if (outcome === "update_card") {
    const summary = readString(decision.summary).trim();
    return {
      ...card,
      title: readString(decision.title).trim() || card.title,
      description: readString(decision.description).trim() || card.description,
      summary: summary || card.summary,
      tags: readStringArray(decision.tags).length > 0 ? readStringArray(decision.tags) : card.tags,
      evidenceLevel: readEvidenceLevel(decision.evidenceLevel) ?? card.evidenceLevel,
      confidence: readConfidence(decision.confidence) ?? card.confidence,
      qualitySignals: readStringArray(decision.qualitySignals).length > 0
        ? readStringArray(decision.qualitySignals)
        : card.qualitySignals,
      sourceRefs: refreshedRefs,
      status: card.status === "draft" ? "draft" : "active",
      statusReason: card.status === "draft" ? card.statusReason : undefined,
    };
  }
  if (outcome === "conflict") {
    return {
      ...card,
      sourceRefs: refreshedRefs,
      status: "conflict",
      statusReason: statusReason ?? "Current source evidence conflicts with this source card.",
    };
  }
  if (outcome === "superseded") {
    return {
      ...card,
      sourceRefs: refreshedRefs,
      status: "stale",
      statusReason: statusReason ? `Superseded: ${statusReason}` : "Superseded by newer source evidence.",
    };
  }
  if (outcome === "stale") {
    return {
      ...card,
      sourceRefs: refreshedRefs,
      status: "stale",
      statusReason: statusReason ?? event.changes[0]?.reason ?? "Source evidence no longer supports this card.",
    };
  }
  return undefined;
}

function normalizeSourceCardDraft(
  value: unknown,
  fallbackSourceRefs: ProjectWikiSourceRef[],
  fallbackSourceType: ProjectWikiSourceType,
  allowedSourceTypes: ProjectWikiSourceType[],
): ProjectWikiSourceCardDraft | undefined {
  if (!isRecord(value)) return undefined;
  const title = readString(value.title).trim();
  const summary = readString(value.summary).trim();
  if (!title || !summary) return undefined;
  const description = readString(value.description).trim() || summarizeForDescription(summary);
  const requestedSourceType = PROJECT_WIKI_SOURCE_TYPES.includes(value.sourceType as ProjectWikiSourceType)
    ? value.sourceType as ProjectWikiSourceType
    : fallbackSourceType;
  const sourceType = allowedSourceTypes.includes(requestedSourceType)
    ? requestedSourceType
    : fallbackSourceType;
  const refs = Array.isArray(value.sourceRefs)
    ? value.sourceRefs.map(normalizeSourceRef).filter((ref): ref is ProjectWikiSourceRef => Boolean(ref))
    : [];
  const sourceRefs = refs.length > 0
    ? enrichSourceRefs(refs, fallbackSourceRefs)
    : fallbackSourceRefs;
  const evidenceLevel = readEvidenceLevel(value.evidenceLevel);
  const confidence = readConfidence(value.confidence);
  const qualitySignals = readStringArray(value.qualitySignals);
  const explicitStatus = value.status === "stale" || value.status === "conflict" || value.status === "draft"
    ? value.status
    : "active";
  const qualityStatus = qualityStatusForSourceCard(sourceType, explicitStatus, confidence, evidenceLevel);
  return {
    sourceType,
    title,
    description,
    summary,
    tags: readStringArray(value.tags),
    status: qualityStatus.status,
    statusReason: optionalString(value.statusReason) ?? qualityStatus.statusReason,
    importance: typeof value.importance === "number" ? value.importance : 0,
    evidenceLevel,
    confidence,
    qualitySignals,
    sourceRefs,
  };
}

function qualityStatusForSourceCard(
  sourceType: ProjectWikiSourceType,
  status: NonNullable<ProjectWikiSourceCardDraft["status"]>,
  confidence: number | undefined,
  evidenceLevel: ProjectWikiSourceCardDraft["evidenceLevel"],
): { status: NonNullable<ProjectWikiSourceCardDraft["status"]>; statusReason?: string } {
  if (sourceType !== "knowledge" || status !== "active") {
    return { status };
  }
  if (confidence !== undefined && confidence < 0.7) {
    return {
      status: "draft",
      statusReason: `Knowledge confidence ${confidence.toFixed(2)} is below the active threshold of 0.70.`,
    };
  }
  if (evidenceLevel === "low") {
    return {
      status: "draft",
      statusReason: "Knowledge evidence level is low; keep this card as draft until stronger evidence exists.",
    };
  }
  return { status };
}

function enrichSourceRefs(
  refs: ProjectWikiSourceRef[],
  fallbackSourceRefs: ProjectWikiSourceRef[],
): ProjectWikiSourceRef[] {
  return refs.map((ref) => {
    const fallback = findSourceRefFallback(ref, fallbackSourceRefs);
    if (!fallback) return ref;
    return {
      ...ref,
      path: ref.path ?? fallback.path,
      sessionId: ref.sessionId ?? fallback.sessionId,
      turnId: ref.turnId ?? fallback.turnId,
      range: ref.range ?? fallback.range,
      contentHash: ref.contentHash ?? fallback.contentHash,
    };
  });
}

function findSourceRefFallback(
  ref: ProjectWikiSourceRef,
  fallbackSourceRefs: ProjectWikiSourceRef[],
): ProjectWikiSourceRef | undefined {
  const exact = fallbackSourceRefs.find((fallback) =>
    fallback.kind === ref.kind
    && (
      (ref.sessionId && fallback.sessionId === ref.sessionId)
      || (ref.turnId && fallback.turnId === ref.turnId)
      || (ref.label && fallback.label === ref.label)
    ));
  if (exact) return exact;
  const sameKind = fallbackSourceRefs.filter((fallback) => fallback.kind === ref.kind);
  if (sameKind.length === 1) return sameKind[0];
  return fallbackSourceRefs.length === 1 ? fallbackSourceRefs[0] : undefined;
}

function normalizeSourceRef(value: unknown): ProjectWikiSourceRef | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value.kind).trim();
  const label = readString(value.label).trim();
  if (!kind || !label) return undefined;
  return {
    kind,
    label,
    path: optionalString(value.path),
    sessionId: optionalString(value.sessionId),
    turnId: optionalString(value.turnId),
    messageId: optionalString(value.messageId),
    excerpt: optionalString(value.excerpt),
    range: normalizeSourceRange(value.range),
    contentHash: optionalString(value.contentHash),
  };
}

function normalizeSourceRange(value: unknown): ProjectWikiSourceRef["range"] | undefined {
  if (!isRecord(value)) return undefined;
  const range: NonNullable<ProjectWikiSourceRef["range"]> = {};
  if (typeof value.startLine === "number" && Number.isFinite(value.startLine)) {
    range.startLine = value.startLine;
  }
  if (typeof value.endLine === "number" && Number.isFinite(value.endLine)) {
    range.endLine = value.endLine;
  }
  if (typeof value.messageIndex === "number" && Number.isFinite(value.messageIndex)) {
    range.messageIndex = value.messageIndex;
  }
  return Object.keys(range).length > 0 ? range : undefined;
}

function normalizePageDraft(value: unknown, fallbackSourceCardIds: string[] = []): {
  pageId: ProjectWikiPageId;
  title: string;
  description: string;
  body: string;
  sourceCardIds: string[];
  changeSummary?: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  if (!PROJECT_WIKI_MAINTAINABLE_PAGE_IDS.includes(value.pageId as ProjectWikiPageId)) return undefined;
  const title = readString(value.title).trim();
  const description = readString(value.description).trim();
  const explicitSourceCardIds = readStringArray(value.sourceCardIds);
  const sourceCardIds = explicitSourceCardIds.length > 0
    ? explicitSourceCardIds
    : fallbackSourceCardIds;
  const changeSummary = optionalString(value.changeSummary);
  const body = sanitizeWikiBody(readString(value.body), title)
    || buildFallbackWikiBody(description, changeSummary, sourceCardIds);
  if (!title || !description || !body) return undefined;
  return {
    pageId: value.pageId as ProjectWikiPageId,
    title,
    description,
    body,
    sourceCardIds,
    changeSummary,
  };
}

function buildFallbackWikiBody(
  description: string,
  changeSummary: string | undefined,
  sourceCardIds: string[],
): string {
  if (!changeSummary) return "";
  const lines = [
    "## Current Understanding",
    changeSummary,
  ];
  if (sourceCardIds.length > 0) {
    lines.push("", "## Source Cards", ...sourceCardIds.map((id) => `- ${id}`));
  }
  if (description) {
    lines.push("", "## Scope", description);
  }
  return lines.join("\n");
}

function sanitizeWikiBody(rawBody: string, title: string): string {
  let body = stripLeadingWikiTitle(rawBody, title);
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      body = body.slice(end + 4).trimStart();
    }
  }
  body = stripLeadingWikiTitle(body, title);
  return body.trim();
}

function stripLeadingWikiTitle(body: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.trim().replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), "").trim();
}

type ValidatedSearchOutputSelection = {
  value: ProjectWikiSearchOutput;
  selectedPaths: string[];
  invalidSelected: Array<{ relativePath: string; reason: string }>;
  traceOutput: ProjectWikiSearchOutput & {
    invalidSelected?: Array<{ relativePath: string; reason: string }>;
  };
};

function validateSearchOutputSelection(
  output: ProjectWikiSearchOutput,
  catalog: ProjectWikiCatalogEntry[],
  limit: number,
): ValidatedSearchOutputSelection {
  const catalogPaths = new Set(catalog.map((entry) => entry.relativePath));
  const invalidSelected: Array<{ relativePath: string; reason: string }> = [];
  const selected: NonNullable<ProjectWikiSearchOutput["selected"]> = [];
  const seen = new Set<string>();
  const max = Math.max(1, limit);
  const candidates = [...(output.selected ?? [])]
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  for (const item of candidates) {
    const rawPath = typeof item.relativePath === "string" ? item.relativePath : "";
    const relativePath = normalizeRetrievableProjectWikiPath(rawPath);
    if (!relativePath || !catalogPaths.has(relativePath)) {
      if (rawPath) {
        invalidSelected.push({
          relativePath: rawPath,
          reason: "Ignored selected path because it is not present in the current ProjectWiki catalog.",
        });
      }
      continue;
    }
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    if (selected.length < max) {
      selected.push({
        ...item,
        relativePath,
      });
    }
  }
  const value: ProjectWikiSearchOutput = {
    ...output,
    selected,
    rejected: [
      ...(output.rejected ?? []),
      ...invalidSelected,
    ],
  };
  const traceOutput = invalidSelected.length > 0
    ? { ...value, invalidSelected }
    : value;
  return {
    value,
    selectedPaths: selected
      .map((item) => item.relativePath)
      .filter((path): path is string => Boolean(path)),
    invalidSelected,
    traceOutput,
  };
}

function activityMaterialFromCatalogEntry(entry: ProjectWikiCatalogEntry): ProjectWikiActivityMaterial {
  return {
    relativePath: entry.relativePath,
    title: entry.title,
    description: entry.description,
    kind: entry.kind,
    sourceType: entry.sourceType,
    status: entry.status,
    preview: truncateText(entry.preview ?? "", 360),
  };
}

function selectedActivityMaterialsFromSearch(
  output: ProjectWikiSearchOutput,
  catalog: ProjectWikiCatalogEntry[],
): ProjectWikiActivityMaterial[] {
  const byPath = new Map(catalog.map((entry) => [entry.relativePath, entry]));
  return (output.selected ?? []).map((item) => ({
    ...(item.relativePath ? activityMaterialFromCatalogEntry(byPath.get(item.relativePath) ?? {
      relativePath: item.relativePath,
      kind: item.relativePath === "home.md" ? "home" : item.relativePath.startsWith("wiki/") ? "wiki" : "source_card",
      title: basename(item.relativePath),
      description: "",
      preview: "",
    } as ProjectWikiCatalogEntry) : {}),
    relativePath: item.relativePath ?? "",
    reason: item.reason,
    priority: item.priority,
  })).filter((item) => item.relativePath);
}

function rejectedActivityMaterialsFromSearch(
  output: ProjectWikiSearchOutput,
  catalog: ProjectWikiCatalogEntry[],
): ProjectWikiActivityMaterial[] {
  const byPath = new Map(catalog.map((entry) => [entry.relativePath, entry]));
  return (output.rejected ?? []).map((item) => {
    const relativePath = typeof item.relativePath === "string" ? item.relativePath : "";
    const catalogEntry = relativePath ? byPath.get(relativePath) : undefined;
    return {
      ...(catalogEntry ? activityMaterialFromCatalogEntry(catalogEntry) : {}),
      relativePath,
      title: catalogEntry?.title ?? (relativePath ? basename(relativePath) : undefined),
      reason: item.reason,
    };
  }).filter((item) => item.relativePath || item.reason);
}

function activityMaterialFromMarkdownFile(
  file: ProjectWikiMarkdownFile,
  catalog: ProjectWikiCatalogEntry[],
): ProjectWikiActivityMaterial {
  const catalogEntry = catalog.find((entry) => entry.relativePath === file.relativePath);
  const title = readString(file.frontmatter.title) || catalogEntry?.title || basename(file.relativePath);
  const description = readString(file.frontmatter.description) || catalogEntry?.description;
  return {
    ...(catalogEntry ? activityMaterialFromCatalogEntry(catalogEntry) : {}),
    relativePath: file.relativePath,
    title,
    description,
    kind: catalogEntry?.kind ?? (file.relativePath === "home.md" ? "home" : file.relativePath.startsWith("wiki/") ? "wiki" : "source_card"),
    sourceType: catalogEntry?.sourceType,
    status: catalogEntry?.status,
    preview: truncateText(file.content.replace(/\s+/g, " ").trim(), 420),
  };
}

function formatRetrieverToolCall(call: RetrieverToolCall): string {
  const input = isRecord(call.input) ? call.input : {};
  if (call.name === "projectwiki_search") {
    const query = readString(input.query) || "";
    return query ? `search: ${truncateText(query, 80)}` : "search";
  }
  if (call.name === "projectwiki_read") {
    const relativePath = readString(input.relativePath) || "";
    return relativePath ? `read: ${relativePath}` : "read";
  }
  return call.name;
}

function activityFromRetrieverToolResult(input: {
  call: RetrieverToolCall;
  payload: unknown;
  isError: boolean;
  catalog: ProjectWikiCatalogEntry[];
  outputLanguage: string;
}): Parameters<NonNullable<ProjectWikiRetrieveInput["onActivity"]>>[0] {
  const catalogMaterials = input.catalog.map(activityMaterialFromCatalogEntry);
  if (input.isError) {
    return {
      phase: "error",
      state: "running",
      title: input.outputLanguage === "zh-CN" ? "ProjectWiki 工具调用遇到错误，正在恢复" : "ProjectWiki tool call hit an error and is recovering",
      detail: truncateText(JSON.stringify(input.payload), 240),
      catalog: catalogMaterials,
      error: truncateText(JSON.stringify(input.payload), 500),
      stats: { catalogCount: input.catalog.length },
    };
  }
  if (input.call.name === "projectwiki_search") {
    const payload = isRecord(input.payload) ? input.payload : {};
    const selected = Array.isArray(payload.selected)
      ? payload.selected.map(materialFromUnknown).filter(isActivityMaterial)
      : [];
    const rejected = Array.isArray(payload.rejected)
      ? payload.rejected.map(materialFromUnknown).filter(isActivityMaterial)
      : [];
    const query = readString(payload.query) || (isRecord(input.call.input) ? readString(input.call.input.query) : undefined);
    return {
      phase: "search",
      state: "running",
      title: input.outputLanguage === "zh-CN" ? "Searcher 返回了候选材料" : "Searcher returned candidate materials",
      detail: query
        ? input.outputLanguage === "zh-CN"
          ? `搜索：${truncateText(query, 96)}`
          : `Search: ${truncateText(query, 96)}`
        : undefined,
      catalog: catalogMaterials,
      selected,
      rejected,
      stats: {
        catalogCount: input.catalog.length,
        selectedCount: selected.length,
        rejectedCount: rejected.length,
      },
    };
  }
  if (input.call.name === "projectwiki_read") {
    const payload = isRecord(input.payload) ? input.payload : {};
    const material = materialFromUnknown(payload);
    const read = isActivityMaterial(material) ? [material] : [];
    return {
      phase: "read",
      state: "running",
      title: input.outputLanguage === "zh-CN" ? "Retriever 读取了 ProjectWiki 材料" : "Retriever read ProjectWiki material",
      detail: material.relativePath,
      catalog: catalogMaterials,
      read,
      stats: {
        catalogCount: input.catalog.length,
        readCount: read.length,
      },
    };
  }
  return {
    phase: "retriever",
    state: "running",
    title: input.outputLanguage === "zh-CN" ? "Retriever 完成了一次工具调用" : "Retriever completed a tool call",
    detail: input.call.name,
    catalog: catalogMaterials,
    stats: { catalogCount: input.catalog.length },
  };
}

function materialFromUnknown(value: unknown): ProjectWikiActivityMaterial {
  const record = isRecord(value) ? value : {};
  const relativePath = readString(record.relativePath) || "";
  return {
    relativePath,
    title: readString(record.title) || (relativePath ? basename(relativePath) : undefined),
    description: readString(record.description),
    kind: readString(record.kind) as ProjectWikiActivityMaterial["kind"],
    sourceType: readString(record.sourceType) as ProjectWikiActivityMaterial["sourceType"],
    status: readString(record.status) as ProjectWikiActivityMaterial["status"],
    reason: readString(record.reason),
    priority: typeof record.priority === "number" && Number.isFinite(record.priority) ? record.priority : undefined,
    preview: readString(record.preview) || readString(record.content),
  };
}

function isActivityMaterial(value: ProjectWikiActivityMaterial): value is ProjectWikiActivityMaterial {
  return typeof value.relativePath === "string" && value.relativePath.length > 0;
}

function retrieverToolGuardReason(
  calls: RetrieverToolCall[],
  state: {
    searchCallCount: number;
    readCallCount: number;
    readPaths: Set<string>;
  },
): string | undefined {
  let nextSearchCount = state.searchCallCount;
  let nextReadCount = state.readCallCount;
  const nextReadPaths = new Set(state.readPaths);
  for (const call of calls) {
    if (call.name === "projectwiki_search") {
      nextSearchCount += 1;
      if (nextSearchCount > RETRIEVER_MAX_SEARCH_CALLS) {
        return "Retriever exceeded the one-search limit; falling back to structured search.";
      }
      continue;
    }
    if (call.name === "projectwiki_read") {
      nextReadCount += 1;
      if (nextReadCount > RETRIEVER_MAX_READ_CALLS) {
        return "Retriever exceeded the two-read limit; falling back to structured search.";
      }
      const relativePath = isRecord(call.input)
        ? normalizeRetrievableProjectWikiPath(readString(call.input.relativePath))
        : undefined;
      if (relativePath) {
        if (nextReadPaths.has(relativePath)) {
          return `Retriever attempted to read ${relativePath} more than once; falling back to structured search.`;
        }
        nextReadPaths.add(relativePath);
      }
    }
  }
  return undefined;
}

function createLinkedAbortSignal(source: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (!source) {
    return { signal: undefined, cleanup: () => {} };
  }
  const controller = new AbortController();
  if (source.aborted) {
    controller.abort(source.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => source.removeEventListener("abort", onAbort),
  };
}

function filterRetrievableCatalog(catalog: ProjectWikiCatalogEntry[]): ProjectWikiCatalogEntry[] {
  return catalog.filter((entry) => isRetrievableProjectWikiPath(entry.relativePath));
}

function mergeCatalogEntries(
  left: ProjectWikiCatalogEntry[],
  right: ProjectWikiCatalogEntry[],
): ProjectWikiCatalogEntry[] {
  const byPath = new Map<string, ProjectWikiCatalogEntry>();
  for (const entry of [...left, ...right]) {
    if (!isRetrievableProjectWikiPath(entry.relativePath) || byPath.has(entry.relativePath)) continue;
    byPath.set(entry.relativePath, entry);
  }
  return [...byPath.values()];
}

function isRetrievableProjectWikiPath(path: string): boolean {
  return normalizeRetrievableProjectWikiPath(path) !== undefined;
}

function normalizeRetrievableProjectWikiPath(value: string): string | undefined {
  const path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path.endsWith(".md")
    || path.startsWith("/")
    || path.startsWith("../")
    || path.includes("/../")
    || path.includes("//")
  ) {
    return undefined;
  }
  if (path === "home.md") {
    return path;
  }
  if (PROJECT_WIKI_PAGE_IDS.some((pageId) => path === `wiki/${pageId}.md`)) {
    return path;
  }
  if (PROJECT_WIKI_SOURCE_TYPES.some((sourceType) => path.startsWith(`source_cards/${sourceType}/`))) {
    return path;
  }
  return undefined;
}

function traceArtifactForPath(path: string): { kind: "source_card" | "wiki_page"; path: string } {
  return {
    kind: path === "home.md" || path.startsWith("wiki/") ? "wiki_page" : "source_card",
    path,
  };
}

function normalizeCuratedContext(output: ProjectWikiCurateOutput, maxChars: number): string {
  const overview = readString(output.context).trim();
  const sections = (output.sections ?? [])
    .map((section) => {
      const title = readString(section.title).trim();
      const content = readString(section.content).trim();
      if (!title || !content) return "";
      const sources = normalizeCuratedSourcePaths(section.sourcePaths);
      const primaryPath = sources[0];
      const entryType = primaryPath ? projectWikiEntryType(primaryPath) : "curated_section";
      return [
        primaryPath
          ? `<entry type="${entryType}" path="${escapeXml(primaryPath)}">`
          : `<entry type="${entryType}">`,
        `<title>${escapeXml(title)}</title>`,
        `<summary>${escapeXml(content)}</summary>`,
        sources.length > 0
          ? [
            "<sourceRefs>",
            ...sources.map((sourcePath) =>
              `  <source type="${projectWikiEntryType(sourcePath)}" path="${escapeXml(sourcePath)}" />`),
            "</sourceRefs>",
          ].join("\n")
          : "",
        "</entry>",
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean);
  const parts = [
    overview ? [
      `<entry type="project_context">`,
      "<title>ProjectWiki Summary</title>",
      `<summary>${escapeXml(overview)}</summary>`,
      "</entry>",
    ].join("\n") : "",
    ...sections,
  ].filter(Boolean);
  const raw = parts.length > 0 ? parts.join("\n\n") : overview;
  return truncateText(raw, maxChars).trim();
}

function traceArtifactsForCuratedOutput(output: ProjectWikiCurateOutput): Array<{
  kind: "source_card" | "wiki_page";
  path: string;
}> {
  const paths = new Set<string>();
  for (const section of output.sections ?? []) {
    for (const sourcePath of normalizeCuratedSourcePaths(section.sourcePaths)) {
      paths.add(sourcePath);
    }
  }
  return [...paths]
    .map((path) => {
      if (path.startsWith("wiki/")) return { kind: "wiki_page" as const, path };
      if (path.startsWith("source_cards/")) return { kind: "source_card" as const, path };
      return undefined;
    })
    .filter((item): item is { kind: "source_card" | "wiki_page"; path: string } => Boolean(item));
}

function normalizeCuratedSourcePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter((item) =>
      item.endsWith(".md")
      && !item.startsWith("/")
      && !item.startsWith("../")
      && !item.includes("/../")
      && isRetrievableProjectWikiPath(item)))];
}

function projectWikiEntryType(path: string): "wiki_page" | "source_card" | "curated_section" {
  if (path === "home.md" || path.startsWith("wiki/")) return "wiki_page";
  if (path.startsWith("source_cards/")) return "source_card";
  return "curated_section";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type RepoDigestFile = {
  absolutePath: string;
  relativePath: string;
  size: number;
  priority: number;
};

const REPO_DIGEST_MAX_DEPTH = 5;
const REPO_DIGEST_MAX_TREE_ENTRIES = 60;
const REPO_DIGEST_MAX_FILE_SNIPPETS = 8;
const REPO_DIGEST_MAX_FILE_BYTES = 180_000;
const REPO_DIGEST_MAX_FILE_CHARS = 1_000;
const REPO_DIGEST_MAX_TOTAL_CHARS = 8_000;

const REPO_DIGEST_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  ".pilotdeck",
  "project_wiki",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
]);

const REPO_DIGEST_EXCLUDED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

const REPO_DIGEST_IMPORTANT_NAMES = new Set([
  "README.md",
  "readme.md",
  "PILOTDECK.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "Dockerfile",
  "docker-compose.yml",
]);

const REPO_DIGEST_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

async function buildRepoDigest(projectRoot: string): Promise<string> {
  return (await buildRepoDigestMaterial(projectRoot)).digest;
}

async function buildRepoDigestMaterial(projectRoot: string): Promise<RepoDigestMaterial> {
  const lines: string[] = [`Project root: ${projectRoot}`];
  const sourceRefs: ProjectWikiSourceRef[] = [];
  const filesForModel: RepoDigestMaterial["files"] = [];
  let entries;
  try {
    entries = await readdir(projectRoot, { withFileTypes: true });
  } catch {
    return { digest: "", sourceRefs: [], files: [] };
  }
  const rootContentHash = hashText(projectRoot);
  sourceRefs.push({
    kind: "repo",
    label: projectRoot,
    path: projectRoot,
    contentHash: rootContentHash,
  });
  const visible = entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist")
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 80);
  lines.push("Top-level entries:");
  for (const entry of visible) {
    lines.push(`- ${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
  }

  const repoDigest = await collectRepoDigest(projectRoot);
  if (repoDigest.tree.length > 0) {
    lines.push("\nRepository tree sample:");
    for (const entry of repoDigest.tree) {
      lines.push(`- ${entry}`);
    }
  }

  if (repoDigest.files.length > 0) {
    lines.push("\nImportant file snippets:");
  }
  for (const file of repoDigest.files.slice(0, REPO_DIGEST_MAX_FILE_SNIPPETS)) {
    try {
      const content = await readFile(file.absolutePath, "utf8");
      const contentHash = hashText(content);
      const lineCount = countLines(content);
      sourceRefs.push({
        kind: "repo_file",
        label: file.relativePath,
        path: file.absolutePath,
        range: { startLine: 1, endLine: lineCount },
        contentHash,
      });
      filesForModel.push({
        relativePath: file.relativePath,
        path: file.absolutePath,
        size: file.size,
        contentHash,
        lineCount,
      });
      lines.push(`\n--- ${file.relativePath} (${file.size} bytes) ---\n${truncateText(content, REPO_DIGEST_MAX_FILE_CHARS)}`);
    } catch {
      // skip unreadable candidates
    }
  }
  return {
    digest: truncateText(lines.join("\n"), REPO_DIGEST_MAX_TOTAL_CHARS),
    sourceRefs,
    files: filesForModel,
  };
}

async function collectRepoDigest(projectRoot: string): Promise<{ tree: string[]; files: RepoDigestFile[] }> {
  const root = resolve(projectRoot);
  const tree: string[] = [];
  const files: RepoDigestFile[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > REPO_DIGEST_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = normalizeRepoRelativePath(relative(root, absolutePath));
      if (!relativePath || shouldSkipRepoDigestEntry(entry.name, relativePath, entry.isDirectory())) {
        continue;
      }
      if (tree.length < REPO_DIGEST_MAX_TREE_ENTRIES) {
        tree.push(`${entry.isDirectory() ? "dir " : "file"} ${relativePath}${entry.isDirectory() ? "/" : ""}`);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isRepoDigestCandidate(relativePath)) continue;
      try {
        const info = await stat(absolutePath);
        if (!info.isFile() || info.size > REPO_DIGEST_MAX_FILE_BYTES) continue;
        files.push({
          absolutePath,
          relativePath,
          size: info.size,
          priority: repoDigestFilePriority(relativePath),
        });
      } catch {
        // skip unreadable candidates
      }
    }
  };

  await walk(root, 0);
  files.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aDepth = a.relativePath.split("/").length;
    const bDepth = b.relativePath.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return { tree, files };
}

function shouldSkipRepoDigestEntry(name: string, relativePath: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    if (REPO_DIGEST_EXCLUDED_DIRS.has(name)) return true;
    return name.startsWith(".") && name !== ".github";
  }
  if (REPO_DIGEST_EXCLUDED_FILES.has(name)) return true;
  if (name.startsWith(".env")) return true;
  if (relativePath.includes("/.env")) return true;
  return false;
}

function isRepoDigestCandidate(relativePath: string): boolean {
  const name = basename(relativePath);
  if (REPO_DIGEST_IMPORTANT_NAMES.has(name)) return true;
  const ext = extname(name).toLowerCase();
  return REPO_DIGEST_SOURCE_EXTENSIONS.has(ext);
}

function repoDigestFilePriority(relativePath: string): number {
  const name = basename(relativePath);
  const lower = relativePath.toLowerCase();
  if (name === "README.md" || name === "readme.md") return 0;
  if (REPO_DIGEST_IMPORTANT_NAMES.has(name)) return 5;
  if (/(^|\/)(index|main|app|server|cli|routes?)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(lower)) return 10;
  if (lower.startsWith("src/")) return 20;
  if (lower.includes("/test") || lower.includes(".test.") || lower.includes(".spec.")) return 35;
  return 50;
}

function normalizeRepoRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function collectLegacyMemoryMarkdown(rootDir: string, projectRoot: string): Promise<LegacyMemoryFile[]> {
  const root = resolve(rootDir);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  const projectHash = legacyMemoryWorkspaceKey(projectRoot);

  const appendFile = (filePath: string) => {
    const normalized = resolve(filePath);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    files.push(normalized);
  };

  const walk = async (dir: string, depth: number, limit: number): Promise<void> => {
    if (depth > 5 || files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1, limit);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        appendFile(absolutePath);
      }
    }
  };

  const currentWorkspaceMemoryDir = join(root, "workspaces", projectHash, "memory");
  if (existsSync(currentWorkspaceMemoryDir)) {
    await walk(currentWorkspaceMemoryDir, 0, 80);
  }

  if (files.length === 0) {
    await walk(root, 0, 40);
  }

  const output: LegacyMemoryFile[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (
        isInsideOrEqual(currentWorkspaceMemoryDir, file)
        || content.includes(projectRoot)
        || content.includes(projectHash)
      ) {
        output.push({
          path: file,
          content,
          contentHash: hashText(content),
          lineCount: countLines(content),
        });
      }
      if (output.length >= 20) break;
    } catch {
      // skip unreadable files
    }
  }
  return output;
}

function legacyMemorySourceHash(files: LegacyMemoryFile[]): string {
  return hashText(files
    .map((file) => `${file.path}\0${file.contentHash}\0${file.lineCount}`)
    .sort()
    .join("\n"));
}

function legacyMemoryWorkspaceKey(projectRoot: string): string {
  return createHash("sha1").update(resolve(projectRoot)).digest("hex").slice(0, 10);
}

function isInsideOrEqual(parentDir: string, childPath: string): boolean {
  const rel = relative(parentDir, childPath);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

async function collectHistoricalTurnMaterials(input: {
  chatDir: string;
  projectRoot: string;
  maxTranscripts: number;
  maxTurns: number;
}): Promise<{ scannedTranscripts: number; turns: HistoricalTurnMaterial[] }> {
  let entries;
  try {
    entries = await readdir(input.chatDir, { withFileTypes: true });
  } catch {
    return { scannedTranscripts: 0, turns: [] };
  }

  const transcriptFiles: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const transcriptPath = join(input.chatDir, entry.name);
    try {
      const info = await stat(transcriptPath);
      if (info.isFile()) transcriptFiles.push({ path: transcriptPath, mtimeMs: info.mtimeMs });
    } catch {
      // Skip unreadable transcript candidates.
    }
  }
  transcriptFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const turns: HistoricalTurnMaterial[] = [];
  const selectedFiles = transcriptFiles.slice(0, Math.max(1, input.maxTranscripts));
  for (const file of selectedFiles) {
    const read = await readTranscript(file.path);
    turns.push(...extractHistoricalTurnsFromTranscript(read.entries, file.path, input.projectRoot));
  }

  const latestTurns = turns
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, input.maxTurns))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    scannedTranscripts: selectedFiles.length,
    turns: latestTurns,
  };
}

function extractHistoricalTurnsFromTranscript(
  entries: AgentTranscriptEntry[],
  transcriptPath: string,
  projectRoot: string,
): HistoricalTurnMaterial[] {
  const turnResults = new Map<string, Extract<AgentTranscriptEntry, { type: "turn_result" }>>();
  for (const entry of entries) {
    if (entry.type === "turn_result") {
      turnResults.set(entry.turnId, entry);
    }
  }
  if (turnResults.size === 0) return [];

  const turns = new Map<string, {
    sessionId: string;
    turnId: string;
    createdAt: string;
    transcriptPath: string;
    messages: CanonicalMessage[];
  }>();

  const getTurn = (entry: AgentTranscriptEntry) => {
    const existing = turns.get(entry.turnId);
    if (existing) return existing;
    const turn = {
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      createdAt: entry.createdAt,
      transcriptPath,
      messages: [] as CanonicalMessage[],
    };
    turns.set(entry.turnId, turn);
    return turn;
  };

  for (const entry of entries) {
    if (!turnResults.has(entry.turnId)) continue;
    if (entry.type === "accepted_input") {
      const turn = getTurn(entry);
      turn.createdAt = minIsoDate(turn.createdAt, entry.createdAt);
      turn.messages.push(...entry.messages);
    } else if (
      entry.type === "assistant_message"
      || entry.type === "tool_result_message"
      || entry.type === "durable_message"
    ) {
      const turn = getTurn(entry);
      turn.createdAt = minIsoDate(turn.createdAt, entry.createdAt);
      turn.messages.push(entry.message);
    }
  }

  const output: HistoricalTurnMaterial[] = [];
  for (const turn of turns.values()) {
    if (turn.messages.length === 0) continue;
    const digest = canonicalMessagesToTextDigest(turn.messages, 16_000);
    if (!digest.trim()) continue;
    const result = turnResults.get(turn.turnId);
    output.push({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      projectRoot,
      transcriptPath: turn.transcriptPath,
      messages: turn.messages,
      errored: result?.result.type !== "success",
      createdAt: result?.result.startedAt ?? turn.createdAt,
      contentHash: hashText(digest),
    });
  }
  return output;
}

function minIsoDate(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right;
}

function historyTurnStateKey(turn: Pick<HistoricalTurnMaterial, "sessionId" | "turnId">): string {
  return `${turn.sessionId}\0${turn.turnId}`;
}

function pruneHistoryBackfillState(
  state: HistoryBackfillState,
  activeTurns: HistoricalTurnMaterial[],
): HistoryBackfillState {
  const activeKeys = new Set(activeTurns.map(historyTurnStateKey));
  const retained = Object.fromEntries(
    Object.entries(state.turns).filter(([key]) => activeKeys.has(key)),
  );
  return {
    version: HISTORY_BACKFILL_STATE_VERSION,
    turns: retained,
  };
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function canonicalMessagesToTextDigest(messages: CanonicalMessage[], maxChars: number): string {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    const chunks: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") chunks.push(block.text);
      else if (block.type === "tool_result") {
        chunks.push(block.content.map((item) => item.type === "text" ? item.text : `[${item.type}]`).join("\n"));
      } else if (block.type === "tool_result_reference") {
        chunks.push(`[tool_result_reference path=${block.path}]\n${block.preview}`);
      } else if (block.type === "media_reference") {
        chunks.push(`[media_reference path=${block.path} mime=${block.mimeType}]\n${block.preview}`);
      } else if (block.type === "tool_call") {
        chunks.push(`[tool_call ${block.name}] ${JSON.stringify(block.input)}`);
      }
    }
    const text = chunks.join("\n").trim();
    if (text) lines.push(`Message ${index + 1} (${message.role}):\n${text}`);
  });
  return truncateText(lines.join("\n\n"), maxChars);
}

function buildTurnSourceRefs(
  input: ProjectWikiCaptureTurnInput,
  digest: string,
): ProjectWikiSourceRef[] {
  const refs: ProjectWikiSourceRef[] = [{
    kind: "transcript",
    label: `${input.sessionId} ${input.turnId}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    path: input.transcriptPath,
    contentHash: hashText(digest),
  }];
  refs.push(...collectPersistedMessageRefs(input.messages, input.sessionId, input.turnId));
  return dedupeSourceRefs(refs).slice(0, 32);
}

function collectPersistedMessageRefs(
  messages: CanonicalMessage[],
  sessionId: string,
  turnId: string,
): ProjectWikiSourceRef[] {
  const refs: ProjectWikiSourceRef[] = [];
  messages.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (block.type === "tool_result_reference") {
        refs.push({
          kind: "tool_result_reference",
          label: block.toolCallId || block.path,
          path: block.path,
          sessionId,
          turnId,
          messageId: `Message ${messageIndex + 1}`,
          excerpt: truncateText(block.preview, 600),
          range: { messageIndex: messageIndex + 1 },
          contentHash: hashText([
            block.path,
            String(block.originalBytes),
            block.preview,
          ].join("\n")),
        });
      } else if (block.type === "media_reference") {
        refs.push({
          kind: "media_reference",
          label: [
            block.mediaType,
            block.toolCallId || block.mimeType,
          ].filter(Boolean).join(" "),
          path: block.path,
          sessionId,
          turnId,
          messageId: `Message ${messageIndex + 1}`,
          excerpt: truncateText(block.preview, 600),
          range: { messageIndex: messageIndex + 1 },
          contentHash: hashText([
            block.path,
            block.mimeType,
            String(block.originalBytes),
            block.preview,
          ].join("\n")),
        });
      }
    }
  });
  return refs;
}

function dedupeSourceRefs(refs: ProjectWikiSourceRef[]): ProjectWikiSourceRef[] {
  const seen = new Set<string>();
  const output: ProjectWikiSourceRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.kind,
      ref.path ?? "",
      ref.sessionId ?? "",
      ref.turnId ?? "",
      ref.messageId ?? "",
      ref.label,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function extractToolCalls(content: CanonicalMessage["content"]): RetrieverToolCall[] {
  return content.filter((block): block is RetrieverToolCall => block.type === "tool_call");
}

function parseSearchOutputFromTextBlocks(content: CanonicalMessage["content"]): ProjectWikiSearchOutput | undefined {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join("")
    .trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isSearchOutput(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mergeUsage(left: CanonicalUsage | undefined, right: CanonicalUsage | undefined): CanonicalUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: sumOptional(left.inputTokens, right.inputTokens),
    outputTokens: sumOptional(left.outputTokens, right.outputTokens),
    cacheReadTokens: sumOptional(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: sumOptional(left.cacheWriteTokens, right.cacheWriteTokens),
    totalTokens: sumOptional(left.totalTokens, right.totalTokens),
    nativeCost: sumOptional(left.nativeCost, right.nativeCost),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  const text = readString(value).trim();
  return text || undefined;
}

function readEvidenceLevel(value: unknown): ProjectWikiSourceCardDraft["evidenceLevel"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function readConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function summarizeForDescription(summary: string): string {
  const firstSentence = summary
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/u)[0]
    ?.trim();
  return truncateText(firstSentence || summary, 220);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
