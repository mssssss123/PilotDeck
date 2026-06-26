import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ProjectWikiPromptLanguage } from "../project-wiki/types.js";
import type { UserProfileMergeOutput } from "./schemas.js";
import {
  USER_PROFILE_CATEGORIES,
  type UserProfileCategory,
  type UserProfileDocument,
  type UserProfileEntry,
  type UserProfileSourceCard,
  type UserProfileSourceRef,
  type UserProfileSourceType,
  type UserProfileTraceRecord,
} from "./types.js";

export type UserProfileStoreOptions = {
  rootDir: string;
  language: ProjectWikiPromptLanguage;
  now?: () => Date;
};

type ApplyOperationInput = {
  operations: NonNullable<UserProfileMergeOutput["operations"]>;
  candidateSourceCards: Array<UserProfileSourceCard | undefined>;
  reasonPrefix?: string;
};

const PROFILE_JSON_VERSION = 1;

export class UserProfileStore {
  readonly rootDir: string;
  private readonly language: ProjectWikiPromptLanguage;
  private readonly now: () => Date;

  constructor(options: UserProfileStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.language = options.language;
    this.now = options.now ?? (() => new Date());
  }

  get profileJsonPath(): string {
    return join(this.rootDir, "profile.json");
  }

  get profileMarkdownPath(): string {
    return join(this.rootDir, "profile.md");
  }

  async ensureInitialized(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "source_cards", "conversations"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "source_cards", "legacy-memory"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "traces"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "state", "migrations"), { recursive: true, mode: 0o700 });
    if (!existsSync(this.profileJsonPath)) {
      const now = this.now().toISOString();
      await this.writeProfileDocument({
        version: PROFILE_JSON_VERSION,
        createdAt: now,
        updatedAt: now,
        entries: [],
      });
    } else if (!existsSync(this.profileMarkdownPath)) {
      await this.writeProfileDocument(await this.readProfileDocumentUnchecked());
    }
  }

  async readProfileDocument(): Promise<UserProfileDocument> {
    await this.ensureInitialized();
    return this.readProfileDocumentUnchecked();
  }

  private async readProfileDocumentUnchecked(): Promise<UserProfileDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.profileJsonPath, "utf8")) as Partial<UserProfileDocument>;
      const now = this.now().toISOString();
      return {
        version: PROFILE_JSON_VERSION,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : now,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
        entries: Array.isArray(parsed.entries)
          ? parsed.entries.map(normalizeEntry).filter((entry): entry is UserProfileEntry => Boolean(entry))
          : [],
      };
    } catch {
      const now = this.now().toISOString();
      return {
        version: PROFILE_JSON_VERSION,
        createdAt: now,
        updatedAt: now,
        entries: [],
      };
    }
  }

  async writeProfileDocument(document: UserProfileDocument): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const normalized: UserProfileDocument = {
      version: PROFILE_JSON_VERSION,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      entries: document.entries.map(normalizeEntry).filter((entry): entry is UserProfileEntry => Boolean(entry)),
    };
    await writeFile(this.profileJsonPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(this.profileMarkdownPath, renderProfileMarkdown(normalized, this.language), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async readProfileContext(maxChars: number): Promise<string | undefined> {
    await this.ensureInitialized();
    const document = await this.readProfileDocument();
    const markdown = renderProfileMarkdown(document, this.language, { contextOnly: true }).trim();
    if (!markdown || document.entries.every((entry) => entry.status !== "active")) return undefined;
    return truncateText(markdown, maxChars);
  }

  async writeSourceCard(input: {
    sourceType: UserProfileSourceType;
    category?: UserProfileCategory;
    title: string;
    summary: string;
    evidence?: string;
    confidence?: number;
    sourceRefs: UserProfileSourceRef[];
  }): Promise<UserProfileSourceCard> {
    await this.ensureInitialized();
    const now = this.now().toISOString();
    const id = `upsc_${timestampForPath(now)}_${safeSlug(input.title).slice(0, 42)}_${randomUUID().slice(0, 8)}`;
    const dirName = input.sourceType === "legacy_memory" ? "legacy-memory" : "conversations";
    const relativePath = toPosix(join("source_cards", dirName, `${id}.md`));
    const absolutePath = join(this.rootDir, relativePath);
    const card: UserProfileSourceCard = {
      id,
      sourceType: input.sourceType,
      category: input.category,
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      confidence: input.confidence,
      sourceRefs: input.sourceRefs,
      relativePath,
      createdAt: now,
    };
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, renderSourceCardMarkdown(card), { encoding: "utf8", mode: 0o600 });
    return card;
  }

  async applyOperations(input: ApplyOperationInput): Promise<UserProfileEntry[]> {
    const document = await this.readProfileDocument();
    const entries = [...document.entries];
    const now = this.now().toISOString();
    const updated: UserProfileEntry[] = [];

    for (const raw of input.operations) {
      const op = raw.op;
      if (op === "skip" || !op) continue;
      const fallbackCard = firstSourceCardForCandidateIndexes(input.candidateSourceCards, raw.sourceCandidateIndexes);
      const category = normalizeCategory(raw.category ?? fallbackCard?.category);
      const content = normalizeWhitespace(raw.content ?? fallbackCard?.summary ?? "");
      const confidence = clampConfidence(raw.confidence ?? fallbackCard?.confidence);
      const sourceRefs = sourceRefsForCandidateIndexes(input.candidateSourceCards, raw.sourceCandidateIndexes);
      const reason = normalizeWhitespace([input.reasonPrefix, raw.reason].filter(Boolean).join(" "));

      if (op === "add") {
        if (!content) continue;
        const entry: UserProfileEntry = {
          id: `up_${timestampForPath(now)}_${safeSlug(content).slice(0, 42)}_${randomUUID().slice(0, 8)}`,
          category,
          content,
          confidence,
          status: "active",
          createdAt: now,
          updatedAt: now,
          reason: reason || undefined,
          sourceRefs,
        };
        entries.push(entry);
        updated.push(entry);
        continue;
      }

      const target = raw.targetId
        ? entries.find((entry) => entry.id === raw.targetId && entry.status === "active")
        : undefined;
      if (!target) continue;

      if (op === "replace") {
        if (!content) continue;
        target.category = category;
        target.content = content;
        target.confidence = confidence;
        target.updatedAt = now;
        target.reason = reason || target.reason;
        target.sourceRefs = mergeSourceRefs(target.sourceRefs, sourceRefs);
        updated.push(target);
      } else if (op === "remove") {
        target.status = "superseded";
        target.updatedAt = now;
        target.reason = reason || target.reason;
        target.sourceRefs = mergeSourceRefs(target.sourceRefs, sourceRefs);
        updated.push(target);
      }
    }

    if (updated.length > 0) {
      await this.writeProfileDocument({
        ...document,
        updatedAt: now,
        entries,
      });
    }
    return updated;
  }

  createTraceId(createdAt = this.now().toISOString()): string {
    return `uptr_${timestampForPath(createdAt)}_${randomUUID().slice(0, 8)}`;
  }

  async appendTrace(trace: Omit<UserProfileTraceRecord, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }): Promise<UserProfileTraceRecord> {
    await this.ensureInitialized();
    const record: UserProfileTraceRecord = {
      ...trace,
      id: trace.id ?? this.createTraceId(trace.createdAt),
      createdAt: trace.createdAt ?? this.now().toISOString(),
    };
    const tracePath = join(this.rootDir, "traces", `${trace.kind}-runs.jsonl`);
    await appendFile(tracePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  async readJsonState<T>(relativePath: string): Promise<T | undefined> {
    await this.ensureInitialized();
    const safe = this.resolveInsideRoot(relativePath);
    try {
      return JSON.parse(await readFile(safe, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async writeJsonState(relativePath: string, value: unknown): Promise<void> {
    await this.ensureInitialized();
    const safe = this.resolveInsideRoot(relativePath);
    await mkdir(dirname(safe), { recursive: true, mode: 0o700 });
    await writeFile(safe, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private resolveInsideRoot(relativePath: string): string {
    const resolved = resolve(this.rootDir, relativePath);
    const rel = relative(this.rootDir, resolved);
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) {
      throw new Error(`Path escapes UserProfile root: ${relativePath}`);
    }
    return resolved;
  }
}

function renderProfileMarkdown(
  document: UserProfileDocument,
  language: ProjectWikiPromptLanguage,
  options: { contextOnly?: boolean } = {},
): string {
  const active = document.entries
    .filter((entry) => entry.status === "active" && entry.content.trim().length > 0)
    .sort((left, right) => left.category.localeCompare(right.category) || left.createdAt.localeCompare(right.createdAt));
  if (active.length === 0) return "";

  const title = language === "zh-CN" ? "用户画像" : "User Profile";
  const intro = language === "zh-CN"
    ? "以下是全局用户级信息，只适用于跨项目仍然成立的长期偏好和背景。当前用户消息、系统设置和项目指令优先于这里的内容。"
    : "This is global user-level context only. It contains durable preferences and background that still apply across projects. Current user messages, system settings, and project instructions override it.";
  const lines = options.contextOnly ? [`# ${title}`, "", intro] : [
    `# ${title}`,
    "",
    intro,
    "",
    `Updated: ${document.updatedAt}`,
  ];

  for (const category of USER_PROFILE_CATEGORIES) {
    const entries = active.filter((entry) => entry.category === category);
    if (entries.length === 0) continue;
    lines.push("", `## ${categoryLabel(category, language)}`);
    for (const entry of entries) {
      lines.push(`- ${entry.content}`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderSourceCardMarkdown(card: UserProfileSourceCard): string {
  return [
    "---",
    `type: "user_profile_source_card"`,
    `id: ${JSON.stringify(card.id)}`,
    `sourceType: ${JSON.stringify(card.sourceType)}`,
    card.category ? `category: ${JSON.stringify(card.category)}` : undefined,
    `title: ${JSON.stringify(card.title)}`,
    `createdAt: ${JSON.stringify(card.createdAt)}`,
    typeof card.confidence === "number" ? `confidence: ${card.confidence}` : undefined,
    `sourceRefs: ${JSON.stringify(card.sourceRefs)}`,
    "---",
    "",
    `# ${card.title}`,
    "",
    "## Summary",
    card.summary,
    card.evidence ? ["", "## Evidence", card.evidence].join("\n") : undefined,
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function normalizeEntry(value: unknown): UserProfileEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = normalizeWhitespace(value.id);
  const content = normalizeWhitespace(value.content);
  if (!id || !content) return undefined;
  return {
    id,
    category: normalizeCategory(value.category),
    content,
    confidence: clampConfidence(typeof value.confidence === "number" ? value.confidence : undefined),
    status: value.status === "superseded" ? "superseded" : "active",
    createdAt: normalizeWhitespace(value.createdAt) || new Date(0).toISOString(),
    updatedAt: normalizeWhitespace(value.updatedAt) || normalizeWhitespace(value.createdAt) || new Date(0).toISOString(),
    reason: normalizeWhitespace(value.reason) || undefined,
    sourceRefs: Array.isArray(value.sourceRefs)
      ? value.sourceRefs.map(normalizeSourceRef).filter((ref): ref is UserProfileSourceRef => Boolean(ref))
      : [],
  };
}

function normalizeSourceRef(value: unknown): UserProfileSourceRef | undefined {
  if (!isRecord(value)) return undefined;
  const kind = normalizeWhitespace(value.kind) || "source";
  const label = normalizeWhitespace(value.label) || kind;
  return {
    kind,
    label,
    path: normalizeWhitespace(value.path) || undefined,
    sessionId: normalizeWhitespace(value.sessionId) || undefined,
    turnId: normalizeWhitespace(value.turnId) || undefined,
    excerpt: normalizeWhitespace(value.excerpt) || undefined,
    contentHash: normalizeWhitespace(value.contentHash) || undefined,
  };
}

function sourceRefsForCandidateIndexes(
  cards: Array<UserProfileSourceCard | undefined>,
  indexes: number[] | undefined,
): UserProfileSourceRef[] {
  const selected = Array.isArray(indexes) && indexes.length > 0 ? indexes : [];
  const refs: UserProfileSourceRef[] = [];
  for (const index of selected) {
    const card = cards[index];
    if (!card) continue;
    refs.push({
      kind: "user_profile_source_card",
      label: card.title,
      path: card.relativePath,
      contentHash: hashText(card.summary),
    });
    refs.push(...card.sourceRefs);
  }
  return mergeSourceRefs([], refs);
}

function firstSourceCardForCandidateIndexes(
  cards: Array<UserProfileSourceCard | undefined>,
  indexes: number[] | undefined,
): UserProfileSourceCard | undefined {
  if (!Array.isArray(indexes) || indexes.length === 0) return undefined;
  for (const index of indexes) {
    const card = cards[index];
    if (card) return card;
  }
  return undefined;
}

function mergeSourceRefs(
  existing: UserProfileSourceRef[] | undefined,
  incoming: UserProfileSourceRef[] | undefined,
): UserProfileSourceRef[] {
  const merged = new Map<string, UserProfileSourceRef>();
  for (const ref of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = JSON.stringify([
      ref.kind,
      ref.path ?? "",
      ref.sessionId ?? "",
      ref.turnId ?? "",
      ref.contentHash ?? "",
      ref.excerpt ?? "",
    ]);
    if (!merged.has(key)) merged.set(key, ref);
  }
  return [...merged.values()].slice(0, 20);
}

function normalizeCategory(value: unknown): UserProfileCategory {
  return typeof value === "string" && USER_PROFILE_CATEGORIES.includes(value as UserProfileCategory)
    ? value as UserProfileCategory
    : "other";
}

function categoryLabel(category: UserProfileCategory, language: ProjectWikiPromptLanguage): string {
  if (language === "zh-CN") {
    switch (category) {
      case "identity":
        return "身份背景";
      case "communication":
        return "沟通偏好";
      case "workflow":
        return "工作方式";
      case "preference":
        return "长期偏好";
      case "constraint":
        return "长期约束";
      case "other":
        return "其他";
    }
  }
  switch (category) {
    case "identity":
      return "Identity";
    case "communication":
      return "Communication";
    case "workflow":
      return "Workflow";
    case "preference":
      return "Preferences";
    case "constraint":
      return "Constraints";
    case "other":
      return "Other";
  }
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function timestampForPath(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14) || "00000000000000";
}

function safeSlug(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "profile";
}

function normalizeWhitespace(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function toPosix(value: string): string {
  return value.split(/[/\\]+/).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
