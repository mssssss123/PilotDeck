import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { CanonicalMessage } from "../model/index.js";
import {
  ProjectWikiModelRunner,
  type ProjectWikiStructuredCallResult,
} from "../project-wiki/ProjectWikiModelRunner.js";
import {
  USER_PROFILE_EXTRACTOR_SYSTEM_PROMPT,
  USER_PROFILE_MAINTAINER_SYSTEM_PROMPT,
  withUserProfileOutputLanguage,
} from "./prompts.js";
import {
  isUserProfileExtractOutput,
  isUserProfileMergeOutput,
  userProfileExtractOutputSchema,
  userProfileMergeOutputSchema,
  type UserProfileExtractOutput,
  type UserProfileMergeOutput,
} from "./schemas.js";
import { UserProfileStore, hashText, truncateText } from "./UserProfileStore.js";
import {
  USER_PROFILE_CATEGORIES,
  type UserProfileCaptureTurnInput,
  type UserProfileCategory,
  type UserProfileContextInput,
  type UserProfileContextResult,
  type UserProfileDiagnostic,
  type UserProfileEntry,
  type UserProfileResolver,
  type UserProfileRuntimeConfig,
  type UserProfileSourceCard,
  type UserProfileSourceRef,
} from "./types.js";

export type UserProfileServiceOptions = {
  store: UserProfileStore;
  modelRunner: ProjectWikiModelRunner;
  config: UserProfileRuntimeConfig;
  legacyMemoryRootDir?: string;
  now?: () => Date;
};

type QueuedUserProfileCaptureInput = UserProfileCaptureTurnInput;

type NormalizedUserProfileCandidate = {
  category: UserProfileCategory;
  content: string;
  evidence?: string;
  confidence?: number;
  reason?: string;
  sourceRefs: UserProfileSourceRef[];
};

type NormalizedUserProfileRemoval = {
  targetDescription: string;
  evidence?: string;
  reason?: string;
  sourceRefs: UserProfileSourceRef[];
};

type UserProfileExtractionResult = {
  candidates: NormalizedUserProfileCandidate[];
  removals: NormalizedUserProfileRemoval[];
};

type LegacyUserProfileMaterial = {
  relativePath: string;
  path: string;
  content: string;
  contentHash: string;
};

type LegacyMigrationState = {
  version: 1;
  status: "completed" | "skipped" | "error";
  sourceRoot?: string;
  sourceHash?: string;
  sourceFiles?: string[];
  migratedAt?: string;
  error?: string;
};

const LEGACY_USER_PROFILE_MIGRATION_STATE_PATH = "state/migrations/legacy-user-profile-v1.json";
const USER_PROFILE_CONTEXT_MAX_CHARS = 3_000;
const USER_PROFILE_TURN_DIGEST_MAX_CHARS = 8_000;
const USER_PROFILE_LEGACY_MAX_FILES = 30;
const USER_PROFILE_LEGACY_MAX_FILE_CHARS = 12_000;

export class UserProfileService implements UserProfileResolver {
  private indexingQueue: Promise<void> = Promise.resolve();
  private readonly store: UserProfileStore;
  private readonly modelRunner: ProjectWikiModelRunner;
  private readonly config: UserProfileRuntimeConfig;
  private readonly legacyMemoryRootDir?: string;
  private readonly now: () => Date;

  constructor(options: UserProfileServiceOptions) {
    this.store = options.store;
    this.modelRunner = options.modelRunner;
    this.config = options.config;
    this.legacyMemoryRootDir = options.legacyMemoryRootDir;
    this.now = options.now ?? (() => new Date());
  }

  async getContext(input: UserProfileContextInput): Promise<UserProfileContextResult> {
    if (!this.config.enabled) {
      return { diagnostics: [] };
    }
    if (input.signal?.aborted) return { diagnostics: [] };
    try {
      await this.store.ensureInitialized();
      const context = await this.store.readProfileContext(
        Math.min(this.config.maxContextChars, USER_PROFILE_CONTEXT_MAX_CHARS),
      );
      if (!context) {
        return { diagnostics: [] };
      }
      return { systemContext: context, diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [{
          code: "user_profile_store_error",
          severity: "warning",
          message: `UserProfile context failed: ${errorMessage(error)}`,
        }],
      };
    }
  }

  async captureTurn(input: UserProfileCaptureTurnInput): Promise<void> {
    if (!this.config.enabled) return;
    const captureInput: QueuedUserProfileCaptureInput = {
      ...input,
      messages: [...input.messages],
    };
    this.indexingQueue = this.indexingQueue
      .catch(() => undefined)
      .then(async () => {
        await this.processCaptureTurn(captureInput);
      })
      .catch(async (error) => {
        try {
          await this.store.appendTrace({
            kind: "index",
            phase: "capture_queue_failed",
            status: "error",
            sessionId: captureInput.sessionId,
            turnId: captureInput.turnId,
            projectRoot: captureInput.projectRoot,
            error: errorMessage(error),
          });
        } catch {
          // UserProfile capture must never break the agent turn.
        }
      });
  }

  async flush(): Promise<void> {
    await this.indexingQueue;
  }

  private async processCaptureTurn(input: QueuedUserProfileCaptureInput): Promise<void> {
    await this.store.ensureInitialized();
    await this.ensureLegacyMemoryImported(input);
    if (input.errored) {
      await this.store.appendTrace({
        kind: "index",
        phase: "turn_extract",
        status: "skipped",
        sessionId: input.sessionId,
        turnId: input.turnId,
        projectRoot: input.projectRoot,
        input: { reason: "Turn ended with error." },
      });
      return;
    }

    const messageDigest = canonicalMessagesToTextDigest(input.messages, USER_PROFILE_TURN_DIGEST_MAX_CHARS);
    if (!messageDigest.trim()) {
      await this.store.appendTrace({
        kind: "index",
        phase: "turn_extract",
        status: "skipped",
        sessionId: input.sessionId,
        turnId: input.turnId,
        projectRoot: input.projectRoot,
        input: { reason: "No text messages to inspect." },
      });
      return;
    }

    const extraction = await this.extractProfileSignals({
      phase: "turn_extract",
      input,
      modelInput: {
        outputLanguage: this.config.language,
        currentProjectRoot: input.projectRoot,
        transcriptPath: input.transcriptPath,
        sessionId: input.sessionId,
        turnId: input.turnId,
        recentMessages: messageDigest,
      },
      fallbackSourceRefs: [{
        kind: "conversation",
        label: "Current conversation turn",
        path: input.transcriptPath,
        sessionId: input.sessionId,
        turnId: input.turnId,
        excerpt: truncateText(messageDigest, 700),
        contentHash: hashText(messageDigest),
      }],
    });
    if (extraction.candidates.length === 0 && extraction.removals.length === 0) return;

    const cards = await this.writeCandidateSourceCards(extraction.candidates, "conversation");
    await this.mergeCandidates({
      phase: "profile_merge",
      input,
      candidates: extraction.candidates,
      removals: extraction.removals,
      cards,
    });
  }

  private async extractProfileSignals(options: {
    phase: string;
    input: Pick<UserProfileCaptureTurnInput, "sessionId" | "turnId" | "projectRoot">;
    modelInput: Record<string, unknown>;
    fallbackSourceRefs: UserProfileSourceRef[];
  }): Promise<UserProfileExtractionResult> {
    const started = Date.now();
    try {
      const result = await this.modelRunner.structured<UserProfileExtractOutput>({
        role: "indexer",
        systemPrompt: withUserProfileOutputLanguage(USER_PROFILE_EXTRACTOR_SYSTEM_PROMPT, this.config.language),
        userPrompt: JSON.stringify(options.modelInput, null, 2),
        schema: userProfileExtractOutputSchema,
        schemaName: "user_profile_extract",
        maxOutputTokens: 2048,
        validate: isUserProfileExtractOutput,
      });
      const extraction = normalizeExtraction(result.value, options.fallbackSourceRefs);
      await this.store.appendTrace({
        kind: "index",
        phase: options.phase,
        status: extraction.candidates.length > 0 || extraction.removals.length > 0 ? "success" : "skipped",
        model: result.model,
        language: this.config.language,
        sessionId: options.input.sessionId,
        turnId: options.input.turnId,
        projectRoot: options.input.projectRoot,
        durationMs: Date.now() - started,
        input: compactTracePayload(options.modelInput),
        output: compactTracePayload(result.value),
        usage: result.response.usage,
      });
      return extraction;
    } catch (error) {
      await this.store.appendTrace({
        kind: "index",
        phase: `${options.phase}_failed`,
        status: "error",
        model: this.modelRunner.resolveModel("indexer"),
        language: this.config.language,
        sessionId: options.input.sessionId,
        turnId: options.input.turnId,
        projectRoot: options.input.projectRoot,
        durationMs: Date.now() - started,
        input: compactTracePayload(options.modelInput),
        error: errorMessage(error),
      });
      return { candidates: [], removals: [] };
    }
  }

  private async mergeCandidates(options: {
    phase: string;
    input: Pick<UserProfileCaptureTurnInput, "sessionId" | "turnId" | "projectRoot">;
    candidates: NormalizedUserProfileCandidate[];
    removals: NormalizedUserProfileRemoval[];
    cards: UserProfileSourceCard[];
  }): Promise<UserProfileEntry[]> {
    const document = await this.store.readProfileDocument();
    const modelInput = {
      outputLanguage: this.config.language,
      currentProjectRoot: options.input.projectRoot,
      existingEntries: document.entries
        .filter((entry) => entry.status === "active")
        .map((entry) => ({
          id: entry.id,
          category: entry.category,
          content: entry.content,
          confidence: entry.confidence,
          updatedAt: entry.updatedAt,
        })),
      candidates: options.candidates.map((candidate, index) => ({
        index,
        category: candidate.category,
        content: candidate.content,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        reason: candidate.reason,
        sourceCardPath: options.cards[index]?.relativePath,
      })),
      removalRequests: options.removals.map((removal, index) => ({
        index,
        targetDescription: removal.targetDescription,
        evidence: removal.evidence,
        reason: removal.reason,
        sourceRefs: removal.sourceRefs,
      })),
    };
    const started = Date.now();
    try {
      const result: ProjectWikiStructuredCallResult<UserProfileMergeOutput> =
        await this.modelRunner.structured<UserProfileMergeOutput>({
          role: "maintainer",
          systemPrompt: withUserProfileOutputLanguage(USER_PROFILE_MAINTAINER_SYSTEM_PROMPT, this.config.language),
          userPrompt: JSON.stringify(modelInput, null, 2),
          schema: userProfileMergeOutputSchema,
          schemaName: "user_profile_merge",
          maxOutputTokens: 2048,
          validate: isUserProfileMergeOutput,
        });
      const operations = Array.isArray(result.value.operations) ? result.value.operations : [];
      const updated = await this.store.applyOperations({
        operations,
        candidateSourceCards: options.cards,
      });
      await this.store.appendTrace({
        kind: "maintain",
        phase: options.phase,
        status: updated.length > 0 ? "success" : "skipped",
        model: result.model,
        language: this.config.language,
        sessionId: options.input.sessionId,
        turnId: options.input.turnId,
        projectRoot: options.input.projectRoot,
        durationMs: Date.now() - started,
        input: compactTracePayload(modelInput),
        output: compactTracePayload(result.value),
        usage: result.response.usage,
        artifacts: updated.map((entry) => ({
          kind: "profile_entry" as const,
          id: entry.id,
          title: entry.category,
        })),
      });
      return updated;
    } catch (error) {
      await this.store.appendTrace({
        kind: "maintain",
        phase: `${options.phase}_failed`,
        status: "error",
        model: this.modelRunner.resolveModel("maintainer"),
        language: this.config.language,
        sessionId: options.input.sessionId,
        turnId: options.input.turnId,
        projectRoot: options.input.projectRoot,
        durationMs: Date.now() - started,
        input: compactTracePayload(modelInput),
        error: errorMessage(error),
      });
      return [];
    }
  }

  private async writeCandidateSourceCards(
    candidates: NormalizedUserProfileCandidate[],
    sourceType: "conversation" | "legacy_memory",
  ): Promise<UserProfileSourceCard[]> {
    const cards: UserProfileSourceCard[] = [];
    for (const candidate of candidates) {
      const title = `${categoryTitle(candidate.category)}: ${truncateText(candidate.content, 80)}`;
      cards.push(await this.store.writeSourceCard({
        sourceType,
        category: candidate.category,
        title,
        summary: candidate.content,
        evidence: candidate.evidence,
        confidence: candidate.confidence,
        sourceRefs: candidate.sourceRefs,
      }));
    }
    return cards;
  }

  private async ensureLegacyMemoryImported(input: UserProfileCaptureTurnInput): Promise<void> {
    if (!this.legacyMemoryRootDir) return;
    const materials = await collectLegacyUserProfileMaterials(this.legacyMemoryRootDir);
    const sourceHash = hashText(JSON.stringify(materials.map((item) => [item.relativePath, item.contentHash])));
    const previous = await this.store.readJsonState<LegacyMigrationState>(LEGACY_USER_PROFILE_MIGRATION_STATE_PATH);
    if (
      previous?.version === 1 &&
      previous.sourceHash === sourceHash &&
      (previous.status === "completed" || previous.status === "skipped")
    ) {
      return;
    }

    if (materials.length === 0) {
      await this.store.writeJsonState(LEGACY_USER_PROFILE_MIGRATION_STATE_PATH, {
        version: 1,
        status: "skipped",
        sourceRoot: this.legacyMemoryRootDir,
        sourceHash,
        sourceFiles: [],
        migratedAt: this.now().toISOString(),
      } satisfies LegacyMigrationState);
      return;
    }

    const modelInput = {
      outputLanguage: this.config.language,
      materialType: "legacy_global_user_profile_memory",
      currentProjectRoot: input.projectRoot,
      legacyFiles: materials.map((item) => ({
        relativePath: item.relativePath,
        path: item.path,
        contentHash: item.contentHash,
        content: truncateText(item.content, USER_PROFILE_LEGACY_MAX_FILE_CHARS),
      })),
    };
    const extraction = await this.extractProfileSignals({
      phase: "legacy_memory_extract",
      input,
      modelInput,
      fallbackSourceRefs: materials.map((item) => ({
        kind: "legacy_user_memory",
        label: item.relativePath,
        path: item.path,
        excerpt: truncateText(item.content, 700),
        contentHash: item.contentHash,
      })),
    });
    if (extraction.candidates.length === 0 && extraction.removals.length === 0) {
      await this.store.writeJsonState(LEGACY_USER_PROFILE_MIGRATION_STATE_PATH, {
        version: 1,
        status: "skipped",
        sourceRoot: this.legacyMemoryRootDir,
        sourceHash,
        sourceFiles: materials.map((item) => item.path),
        migratedAt: this.now().toISOString(),
      } satisfies LegacyMigrationState);
      return;
    }

    const cards = await this.writeCandidateSourceCards(extraction.candidates, "legacy_memory");
    await this.mergeCandidates({
      phase: "legacy_profile_merge",
      input,
      candidates: extraction.candidates,
      removals: extraction.removals,
      cards,
    });
    await this.store.writeJsonState(LEGACY_USER_PROFILE_MIGRATION_STATE_PATH, {
      version: 1,
      status: "completed",
      sourceRoot: this.legacyMemoryRootDir,
      sourceHash,
      sourceFiles: materials.map((item) => item.path),
      migratedAt: this.now().toISOString(),
    } satisfies LegacyMigrationState);
  }
}

function normalizeExtraction(
  output: UserProfileExtractOutput,
  fallbackSourceRefs: UserProfileSourceRef[],
): UserProfileExtractionResult {
  if (output.hasUserProfileSignal === false) return { candidates: [], removals: [] };
  const candidates: NormalizedUserProfileCandidate[] = [];
  for (const raw of output.candidates ?? []) {
    const content = normalizeWhitespace(raw.content ?? "");
    if (!content) continue;
    candidates.push({
      category: normalizeCategory(raw.category),
      content,
      evidence: normalizeWhitespace(raw.evidence ?? "") || undefined,
      confidence: clampConfidence(raw.confidence),
      reason: normalizeWhitespace(raw.reason ?? "") || undefined,
      sourceRefs: fallbackSourceRefs,
    });
  }
  const removals: NormalizedUserProfileRemoval[] = [];
  for (const raw of output.removals ?? []) {
    const targetDescription = normalizeWhitespace(
      raw.targetDescription ?? raw.evidence ?? raw.reason ?? "",
    );
    if (!targetDescription) continue;
    removals.push({
      targetDescription,
      evidence: normalizeWhitespace(raw.evidence ?? "") || undefined,
      reason: normalizeWhitespace(raw.reason ?? "") || undefined,
      sourceRefs: fallbackSourceRefs,
    });
  }
  return {
    candidates: candidates.slice(0, 12),
    removals: removals.slice(0, 12),
  };
}

async function collectLegacyUserProfileMaterials(rootDir: string): Promise<LegacyUserProfileMaterial[]> {
  const root = resolve(rootDir);
  const files: string[] = [];
  const profilePath = join(root, "global", "UserIdentity", "user-profile.md");
  if (existsSync(profilePath)) files.push(profilePath);
  const notesDir = join(root, "global", "UserIdentityNotes");
  if (existsSync(notesDir)) {
    await walkMarkdownFiles(notesDir, files, USER_PROFILE_LEGACY_MAX_FILES);
  }
  const materials: LegacyUserProfileMaterial[] = [];
  for (const path of files.slice(0, USER_PROFILE_LEGACY_MAX_FILES)) {
    try {
      const content = await readFile(path, "utf8");
      const relativePath = toPosix(relative(root, path)) || basename(path);
      materials.push({
        relativePath,
        path,
        content,
        contentHash: hashText(content),
      });
    } catch {
      continue;
    }
  }
  return materials;
}

async function walkMarkdownFiles(dir: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownFiles(full, files, limit);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      try {
        if ((await stat(full)).size <= 200_000) files.push(full);
      } catch {
        // Ignore unreadable legacy files.
      }
    }
  }
}

function canonicalMessagesToTextDigest(messages: CanonicalMessage[], maxChars: number): string {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    const chunks: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) chunks.push(block.text.trim());
    }
    const text = chunks.join("\n").trim();
    if (text) lines.push(`Message ${index + 1} (${message.role}):\n${text}`);
  });
  return truncateText(lines.join("\n\n"), maxChars);
}

function compactTracePayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateText(value, depth === 0 ? 1_500 : 700);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactTracePayload(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      output[key] = compactTracePayload(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function categoryTitle(category: UserProfileCategory): string {
  switch (category) {
    case "identity":
      return "Identity";
    case "communication":
      return "Communication";
    case "workflow":
      return "Workflow";
    case "preference":
      return "Preference";
    case "constraint":
      return "Constraint";
    case "other":
      return "User Profile";
  }
}

function normalizeCategory(value: unknown): UserProfileCategory {
  return typeof value === "string" && USER_PROFILE_CATEGORIES.includes(value as UserProfileCategory)
    ? value as UserProfileCategory
    : "other";
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function timestampForPath(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14) || "00000000000000";
}

function toPosix(value: string): string {
  return value.split(/[/\\]+/).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
