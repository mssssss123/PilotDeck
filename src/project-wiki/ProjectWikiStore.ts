import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CanonicalMessage } from "../model/index.js";
import {
  readTranscript,
  sanitizeSessionIdForPath,
  type AgentTranscriptEntry,
} from "../session/index.js";
import type {
  ProjectWikiCatalogEntry,
  ProjectWikiConflictRecord,
  ProjectWikiPageDraft,
  ProjectWikiPageId,
  ProjectWikiPageRecord,
  ProjectWikiWikiPageId,
  ProjectWikiSourceCardDraft,
  ProjectWikiSourceCardRecord,
  ProjectWikiSourceChangeEvent,
  ProjectWikiSourceRefChange,
  ProjectWikiSourceHealth,
  ProjectWikiSourceRef,
  ProjectWikiSourceRange,
  ProjectWikiSourceType,
  ProjectWikiTraceKind,
  ProjectWikiTracePayloadRefs,
  ProjectWikiTraceRecord,
} from "./types.js";
import {
  PROJECT_WIKI_PAGE_IDS,
  PROJECT_WIKI_SOURCE_TYPES,
} from "./types.js";

export type ProjectWikiStoreOptions = {
  rootDir: string;
  projectRoot: string;
  now?: () => Date;
};

export type ProjectWikiMarkdownFile = {
  relativePath: string;
  absolutePath: string;
  content: string;
  frontmatter: Record<string, unknown>;
};

type ProjectWikiMaintenanceEvent = {
  op: "enqueue" | "processed";
  key: string;
  cardId?: string;
  relativePath?: string;
  sourceType?: ProjectWikiSourceType;
  title?: string;
  sessionId?: string;
  turnId?: string;
  queuedAt?: string;
  processedAt?: string;
  traceId?: string;
};

type ProjectWikiAppendTraceInput =
  & Omit<ProjectWikiTraceRecord, "id" | "createdAt" | "payloadRefs">
  & {
    id?: string;
    createdAt?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
    payloads?: Partial<Record<keyof ProjectWikiTracePayloadRefs, unknown>>;
  };

const DEFAULT_PAGE_TITLES: Record<ProjectWikiWikiPageId, { title: string; description: string }> = {
  "project-overview": {
    title: "Project Overview",
    description: "What this project is, how it is structured, and what major parts matter.",
  },
  "project-status": {
    title: "Project Status",
    description: "Current project state, active direction, decisions, blockers, and next steps.",
  },
  "project-feedback": {
    title: "Project Feedback",
    description: "Project-specific feedback, constraints, and preferences from the user.",
  },
  knowledge: {
    title: "Knowledge",
    description: "High-quality knowledge produced or validated during agent work.",
  },
};

export class ProjectWikiStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  private readonly now: () => Date;

  constructor(options: ProjectWikiStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.projectRoot = resolve(options.projectRoot);
    this.now = options.now ?? (() => new Date());
  }

  get homePath(): string {
    return join(this.rootDir, "home.md");
  }

  async ensureInitialized(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "wiki"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "source_cards"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "traces"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.rootDir, "conflicts"), { recursive: true, mode: 0o700 });
    for (const sourceType of PROJECT_WIKI_SOURCE_TYPES) {
      await mkdir(join(this.rootDir, "source_cards", sourceType), { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.homePath)) {
      await writeFile(this.homePath, this.buildHomeMarkdown(), { encoding: "utf8", mode: 0o600 });
    } else {
      await this.repairHomeMarkdown();
    }
    for (const pageId of PROJECT_WIKI_PAGE_IDS) {
      const pagePath = join(this.rootDir, "wiki", `${pageId}.md`);
      if (!existsSync(pagePath)) {
        const meta = DEFAULT_PAGE_TITLES[pageId];
        await writeFile(
          pagePath,
          renderMarkdown({
            frontmatter: {
              type: "wiki_page",
              pageId,
              title: meta.title,
              description: meta.description,
              updatedAt: this.now().toISOString(),
              sourceCardIds: [],
            },
            title: meta.title,
            body:
              "This page has not been refined yet. ProjectWiki Maintainer will update it from source cards.",
          }),
          { encoding: "utf8", mode: 0o600 },
        );
      } else {
        await this.repairWikiPageEnvelope(pagePath);
      }
    }
    await this.repairSourceCards();
  }

  async listCatalog(limitChars: number): Promise<ProjectWikiCatalogEntry[]> {
    await this.ensureInitialized();
    const files = await this.listMarkdownFiles();
    const sourceCardsById = buildSourceCardSummaryIndex(this.rootDir, files);
    const catalogFiles = files
      .map((file) => ({
        ...file,
        relativePath: toPosix(relative(this.rootDir, file.absolutePath)),
      }))
      .filter((file) => isCatalogMarkdownPath(file.relativePath))
      .sort((left, right) => compareCatalogPaths(left.relativePath, right.relativePath));
    const entries: ProjectWikiCatalogEntry[] = [];
    let totalChars = 0;
    for (const file of catalogFiles) {
      const parsed = parseMarkdown(file.content);
      const frontmatter = parsed.frontmatter;
      const relativePath = file.relativePath;
      const kind = relativePath === "home.md"
        ? "home"
        : relativePath.startsWith("wiki/")
          ? "wiki"
          : "source_card";
      const preview = truncateText(parsed.body.replace(/\s+/g, " ").trim(), 900);
      const sourceCardIds = kind === "wiki" || kind === "home"
        ? normalizeStringArray(frontmatter.sourceCardIds)
        : [];
      const status = kind === "source_card" ? normalizeSourceCardStatus(frontmatter.status) : undefined;
      const statusReason = kind === "source_card" ? optionalString(frontmatter.statusReason) : undefined;
      const sourceHealth = (kind === "wiki" || kind === "home") && sourceCardIds.length > 0
        ? computeSourceHealth(sourceCardIds, sourceCardsById)
        : undefined;
      const entry: ProjectWikiCatalogEntry = {
        relativePath,
        kind,
        title: readString(frontmatter.title) || inferTitle(parsed.body) || basename(relativePath),
        description: readString(frontmatter.description),
        sourceCardId: kind === "source_card" ? optionalString(frontmatter.id) : undefined,
        sourceType: readSourceType(frontmatter.sourceType),
        status,
        statusReason,
        sourceCardIds,
        sourceHealth,
        updatedAt: readString(frontmatter.updatedAt),
        tags: readStringArray(frontmatter.tags),
        evidenceLevel: readEvidenceLevel(frontmatter.evidenceLevel),
        confidence: readConfidence(frontmatter.confidence),
        qualitySignals: normalizeStringArray(frontmatter.qualitySignals),
        preview,
      };
      totalChars += JSON.stringify(entry).length;
      if (totalChars > limitChars && entries.length > 0 && !isCoreCatalogMarkdownPath(relativePath)) {
        break;
      }
      entries.push(entry);
    }
    return entries;
  }

  async readRelative(relativePath: string): Promise<ProjectWikiMarkdownFile | undefined> {
    await this.ensureInitialized();
    const safe = this.resolveInsideRoot(relativePath);
    if (!safe.endsWith(".md")) return undefined;
    try {
      const content = await readFile(safe, "utf8");
      return {
        relativePath: toPosix(relative(this.rootDir, safe)),
        absolutePath: safe,
        content,
        frontmatter: parseMarkdown(content).frontmatter,
      };
    } catch {
      return undefined;
    }
  }

  async readMany(relativePaths: string[]): Promise<ProjectWikiMarkdownFile[]> {
    const files: ProjectWikiMarkdownFile[] = [];
    for (const path of relativePaths) {
      const file = await this.readRelative(path);
      if (file) files.push(file);
    }
    return files;
  }

  async readWikiPages(): Promise<ProjectWikiMarkdownFile[]> {
    await this.ensureInitialized();
    const pages: ProjectWikiMarkdownFile[] = [];
    for (const pageId of PROJECT_WIKI_PAGE_IDS) {
      const page = await this.readRelative(`wiki/${pageId}.md`);
      if (page) pages.push(page);
    }
    return pages;
  }

  async writeSourceCard(card: ProjectWikiSourceCardDraft): Promise<ProjectWikiSourceCardRecord> {
    await this.ensureInitialized();
    const now = this.now().toISOString();
    const sourceType = PROJECT_WIKI_SOURCE_TYPES.includes(card.sourceType) ? card.sourceType : "knowledge";
    const existing = await this.findReusableSourceCard(sourceType, card);
    if (existing) {
      const mergedStatus = mergeSourceCardStatus(existing.status, card.status);
      const merged: ProjectWikiSourceCardRecord = {
        ...existing,
        description: preferLongerText(existing.description, card.description),
        summary: preferLongerText(existing.summary, card.summary),
        tags: mergeStringArrays(existing.tags, card.tags),
        status: mergedStatus,
        statusReason: mergeSourceCardStatusReason(existing, card, mergedStatus),
        importance: Math.max(existing.importance ?? 0, card.importance ?? 0),
        evidenceLevel: mergeEvidenceLevel(existing.evidenceLevel, card.evidenceLevel),
        confidence: mergeConfidence(existing.confidence, card.confidence),
        qualitySignals: mergeStringArrays(existing.qualitySignals, card.qualitySignals),
        sourceRefs: mergeSourceRefs(existing.sourceRefs, card.sourceRefs),
        updatedAt: now,
      };
      await writeFile(
        join(this.rootDir, merged.relativePath),
        renderSourceCardMarkdown(merged),
        { encoding: "utf8", mode: 0o600 },
      );
      return merged;
    }

    const id = `sc_${timestampForPath(now)}_${safeSlug(card.title).slice(0, 48)}_${randomUUID().slice(0, 8)}`;
    const relativePath = toPosix(join("source_cards", sourceType, `${id}.md`));
    const absolutePath = join(this.rootDir, relativePath);
    const record: ProjectWikiSourceCardRecord = {
      ...card,
      id,
      sourceType,
      status: card.status ?? "active",
      statusReason: card.statusReason,
      tags: normalizeStringArray(card.tags),
      evidenceLevel: card.evidenceLevel,
      confidence: card.confidence,
      qualitySignals: normalizeStringArray(card.qualitySignals),
      sourceRefs: card.sourceRefs ?? [],
      createdAt: now,
      updatedAt: now,
      relativePath,
    };
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(
      absolutePath,
      renderSourceCardMarkdown(record),
      { encoding: "utf8", mode: 0o600 },
    );
    return record;
  }

  private async findReusableSourceCard(
    sourceType: ProjectWikiSourceType,
    card: ProjectWikiSourceCardDraft,
  ): Promise<ProjectWikiSourceCardRecord | undefined> {
    const dir = join(this.rootDir, "source_cards", sourceType);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const candidates: ProjectWikiSourceCardRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const record = await this.readSourceCardRecord(toPosix(join("source_cards", sourceType, entry.name)));
      if (!record || record.sourceType !== sourceType) continue;
      if (record.status === "stale" || record.status === "conflict") continue;
      if (isReusableSourceCard(record, card)) candidates.push(record);
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async markSourceCardsStale(
    sourceType: ProjectWikiSourceType,
    reason: string,
  ): Promise<ProjectWikiSourceCardRecord[]> {
    await this.ensureInitialized();
    const dir = join(this.rootDir, "source_cards", sourceType);
    const staleCards: ProjectWikiSourceCardRecord[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const absolutePath = join(dir, entry.name);
      const relativePath = toPosix(relative(this.rootDir, absolutePath));
      let content: string;
      try {
        content = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseMarkdown(content);
      if (readString(parsed.frontmatter.type) !== "source_card") continue;
      if (readString(parsed.frontmatter.status) === "stale") continue;
      const id = readString(parsed.frontmatter.id);
      const title = readString(parsed.frontmatter.title) || inferTitle(parsed.body);
      const description = readString(parsed.frontmatter.description);
      const summary = extractMarkdownSection(parsed.body, "Summary");
      const createdAt = readString(parsed.frontmatter.createdAt);
      if (!id || !title || !description || !summary || !createdAt) continue;
      const record: ProjectWikiSourceCardRecord = {
        id,
        sourceType,
        title,
        description,
        summary,
        tags: normalizeStringArray(parsed.frontmatter.tags),
        status: "stale",
        statusReason: reason,
        importance: typeof parsed.frontmatter.importance === "number" ? parsed.frontmatter.importance : 0,
        evidenceLevel: readEvidenceLevel(parsed.frontmatter.evidenceLevel),
        confidence: readConfidence(parsed.frontmatter.confidence),
        qualitySignals: normalizeStringArray(parsed.frontmatter.qualitySignals),
        sourceRefs: readSourceRefs(parsed.frontmatter.sourceRefs),
        createdAt,
        updatedAt: this.now().toISOString(),
        relativePath,
      };
      await writeFile(absolutePath, renderSourceCardMarkdown(record), { encoding: "utf8", mode: 0o600 });
      staleCards.push(record);
    }
    return staleCards;
  }

  async observeSourceCardChanges(options: { includeStale?: boolean } = {}): Promise<ProjectWikiSourceChangeEvent[]> {
    await this.ensureInitialized();
    const events: ProjectWikiSourceChangeEvent[] = [];
    for (const sourceType of PROJECT_WIKI_SOURCE_TYPES) {
      const dir = join(this.rootDir, "source_cards", sourceType);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const relativePath = toPosix(join("source_cards", sourceType, entry.name));
        const record = await this.readSourceCardRecord(relativePath);
        if (!record || record.status === "conflict") continue;
        if (record.status === "stale" && !options.includeStale) continue;
        const event = await observeSourceCardChange(record, {
          forceRecheck: record.status === "stale" && options.includeStale,
        });
        if (event) events.push({ ...event, observedAt: this.now().toISOString() });
      }
    }
    return events;
  }

  async updateSourceCardRecord(card: ProjectWikiSourceCardRecord): Promise<ProjectWikiSourceCardRecord> {
    await this.ensureInitialized();
    const record: ProjectWikiSourceCardRecord = {
      ...card,
      tags: normalizeStringArray(card.tags),
      qualitySignals: normalizeStringArray(card.qualitySignals),
      sourceRefs: card.sourceRefs ?? [],
      updatedAt: this.now().toISOString(),
    };
    await writeFile(join(this.rootDir, record.relativePath), renderSourceCardMarkdown(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    return record;
  }

  async refreshSourceCardFreshness(): Promise<ProjectWikiSourceCardRecord[]> {
    await this.ensureInitialized();
    const staleCards: ProjectWikiSourceCardRecord[] = [];
    for (const sourceType of PROJECT_WIKI_SOURCE_TYPES) {
      const dir = join(this.rootDir, "source_cards", sourceType);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const relativePath = toPosix(join("source_cards", sourceType, entry.name));
        const record = await this.readSourceCardRecord(relativePath);
        if (!record || record.status === "stale" || record.status === "conflict") continue;
        const issue = await findSourceCardFreshnessIssue(record);
        if (!issue) continue;
        const stale: ProjectWikiSourceCardRecord = {
          ...record,
          status: "stale",
          statusReason: issue,
          updatedAt: this.now().toISOString(),
        };
        await writeFile(join(this.rootDir, stale.relativePath), renderSourceCardMarkdown(stale), {
          encoding: "utf8",
          mode: 0o600,
        });
        staleCards.push(stale);
      }
    }
    return staleCards;
  }

  async writeWikiPage(page: ProjectWikiPageDraft): Promise<ProjectWikiPageRecord> {
    await this.ensureInitialized();
    const now = this.now().toISOString();
    if (page.pageId === "home") {
      const record: ProjectWikiPageRecord = {
        ...page,
        pageId: "home",
        sourceCardIds: page.sourceCardIds ?? [],
        relativePath: "home.md",
        updatedAt: now,
      };
      await writeFile(
        this.homePath,
        renderMarkdown({
          frontmatter: {
            type: "project_wiki_home",
            pageId: "home",
            title: record.title,
            description: record.description,
            projectRoot: this.projectRoot,
            updatedAt: now,
            sourceCardIds: record.sourceCardIds,
            changeSummary: record.changeSummary ?? "",
          },
          title: record.title,
          body: record.body,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      return record;
    }
    const pageId = PROJECT_WIKI_PAGE_IDS.includes(page.pageId as ProjectWikiWikiPageId)
      ? page.pageId as ProjectWikiWikiPageId
      : "knowledge";
    const relativePath = toPosix(join("wiki", `${pageId}.md`));
    const absolutePath = join(this.rootDir, relativePath);
    const record: ProjectWikiPageRecord = {
      ...page,
      pageId,
      sourceCardIds: page.sourceCardIds ?? [],
      relativePath,
      updatedAt: now,
    };
    await writeFile(
      absolutePath,
      renderMarkdown({
        frontmatter: {
          type: "wiki_page",
          pageId,
          title: record.title,
          description: record.description,
          updatedAt: now,
          sourceCardIds: record.sourceCardIds,
          changeSummary: record.changeSummary ?? "",
        },
        title: record.title,
        body: record.body,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    return record;
  }

  createTraceId(createdAt = this.now().toISOString()): string {
    return `tr_${timestampForPath(createdAt)}_${randomUUID().slice(0, 8)}`;
  }

  async appendTrace(trace: ProjectWikiAppendTraceInput): Promise<ProjectWikiTraceRecord> {
    await this.ensureInitialized();
    const { rawInput, rawOutput, payloads, ...traceFields } = trace;
    const createdAt = trace.createdAt ?? this.now().toISOString();
    const record: ProjectWikiTraceRecord = {
      ...traceFields,
      id: traceFields.id ?? this.createTraceId(createdAt),
      createdAt,
    };
    const payloadRefs: NonNullable<ProjectWikiTraceRecord["payloadRefs"]> = {};
    if (rawInput !== undefined) {
      payloadRefs.input = await this.writeTracePayload(record.id, "input", rawInput);
    }
    if (rawOutput !== undefined) {
      payloadRefs.output = await this.writeTracePayload(record.id, "output", rawOutput);
    }
    for (const [key, value] of Object.entries(payloads ?? {}) as Array<[keyof ProjectWikiTracePayloadRefs, unknown]>) {
      if (value === undefined) continue;
      payloadRefs[key] = await this.writeTracePayload(record.id, key, value);
    }
    if (Object.keys(payloadRefs).length > 0) {
      record.payloadRefs = payloadRefs;
    }
    const tracePath = join(this.rootDir, "traces", `${trace.kind}-runs.jsonl`);
    await appendFile(tracePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  private async writeTracePayload(
    traceId: string,
    side: keyof ProjectWikiTracePayloadRefs,
    payload: unknown,
  ): Promise<string> {
    const relativePath = toPosix(join("traces", "payloads", `${traceId}-${side}.json`));
    const absolutePath = join(this.rootDir, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, `${stringifyTracePayload(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    return relativePath;
  }

  async appendConflicts(
    conflicts: Array<{ topic?: string; summary?: string; sourceCardIds?: string[] }>,
    traceId?: string,
  ): Promise<ProjectWikiConflictRecord[]> {
    await this.ensureInitialized();
    const existing = await this.readConflictEvents();
    const existingByKey = new Map<string, ProjectWikiConflictRecord>();
    for (const record of existing) {
      existingByKey.set(conflictKey(record.topic, record.sourceCardIds), record);
    }
    const records: ProjectWikiConflictRecord[] = [];
    for (const conflict of conflicts) {
      const topic = readString(conflict.topic).trim();
      const summary = readString(conflict.summary).trim();
      if (!topic || !summary) continue;
      const now = this.now().toISOString();
      const sourceCardIds = normalizeStringArray(conflict.sourceCardIds);
      const existingRecord = existingByKey.get(conflictKey(topic, sourceCardIds));
      records.push({
        id: existingRecord?.id ?? `cf_${timestampForPath(now)}_${safeSlug(topic).slice(0, 48)}_${randomUUID().slice(0, 8)}`,
        topic,
        summary,
        sourceCardIds,
        createdAt: existingRecord?.createdAt ?? now,
        updatedAt: now,
        status: "open",
        traceId: traceId ?? existingRecord?.traceId,
      });
    }
    if (records.length === 0) return [];
    const conflictPath = join(this.rootDir, "conflicts", "conflicts.jsonl");
    await appendJsonLines(conflictPath, records);
    return records;
  }

  async readConflicts(limit = 100): Promise<ProjectWikiConflictRecord[]> {
    await this.ensureInitialized();
    const recordsById = new Map<string, ProjectWikiConflictRecord>();
    for (const record of await this.readConflictEvents()) {
      recordsById.set(record.id, record);
    }
    return [...recordsById.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async updateConflictStatus(
    id: string,
    status: ProjectWikiConflictRecord["status"],
  ): Promise<ProjectWikiConflictRecord | undefined> {
    await this.ensureInitialized();
    const recordsById = new Map<string, ProjectWikiConflictRecord>();
    for (const record of await this.readConflictEvents()) {
      recordsById.set(record.id, record);
    }
    const existing = recordsById.get(id);
    if (!existing) return undefined;
    const next: ProjectWikiConflictRecord = {
      ...existing,
      sourceCardIds: normalizeStringArray(existing.sourceCardIds),
      status,
      updatedAt: this.now().toISOString(),
    };
    const conflictPath = join(this.rootDir, "conflicts", "conflicts.jsonl");
    await appendJsonLines(conflictPath, [next]);
    return next;
  }

  private async readConflictEvents(): Promise<ProjectWikiConflictRecord[]> {
    const conflictPath = join(this.rootDir, "conflicts", "conflicts.jsonl");
    let raw: string;
    try {
      raw = await readFile(conflictPath, "utf8");
    } catch {
      return [];
    }
    const records: ProjectWikiConflictRecord[] = [];
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as ProjectWikiConflictRecord;
        if (parsed?.id && parsed.topic && parsed.summary) records.push(parsed);
      } catch {
        // Ignore malformed conflict rows; traceability should stay best-effort.
      }
    }
    return records;
  }

  async readTrace(kind: ProjectWikiTraceKind, limit = 100): Promise<ProjectWikiTraceRecord[]> {
    await this.ensureInitialized();
    const tracePath = join(this.rootDir, "traces", `${kind}-runs.jsonl`);
    let raw: string;
    try {
      raw = await readFile(tracePath, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
    const records: ProjectWikiTraceRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as ProjectWikiTraceRecord);
      } catch {
        // Ignore malformed trace rows; trace visibility should be best-effort.
      }
    }
    return records.reverse();
  }

  async hasSourceCards(sourceType?: ProjectWikiSourceType): Promise<boolean> {
    await this.ensureInitialized();
    const dirs = sourceType ? [join(this.rootDir, "source_cards", sourceType)] :
      PROJECT_WIKI_SOURCE_TYPES.map((type) => join(this.rootDir, "source_cards", type));
    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  async enqueueMaintenanceCards(
    cards: ProjectWikiSourceCardRecord[],
    input: { sessionId?: string; turnId?: string },
  ): Promise<void> {
    await this.ensureInitialized();
    if (cards.length === 0) return;
    const now = this.now().toISOString();
    const events: ProjectWikiMaintenanceEvent[] = cards.map((card) => ({
      op: "enqueue",
      key: maintenanceKeyForCard(card),
      cardId: card.id,
      relativePath: card.relativePath,
      sourceType: card.sourceType,
      title: card.title,
      sessionId: input.sessionId,
      turnId: input.turnId,
      queuedAt: now,
    }));
    await appendFile(
      this.maintenanceStatePath,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async hasPendingMaintenanceCards(): Promise<boolean> {
    await this.ensureInitialized();
    const pending = await this.readPendingMaintenanceEvents();
    return pending.length > 0;
  }

  async readPendingMaintenanceCards(limit = 80): Promise<ProjectWikiSourceCardRecord[]> {
    await this.ensureInitialized();
    const events = await this.readPendingMaintenanceEvents();
    const cards: ProjectWikiSourceCardRecord[] = [];
    for (const event of events.slice(0, Math.max(1, limit))) {
      if (!event.relativePath) continue;
      const card = await this.readSourceCardRecord(event.relativePath);
      if (card) cards.push(card);
    }
    return cards;
  }

  async markMaintenanceCardsProcessed(
    cards: ProjectWikiSourceCardRecord[],
    traceId?: string,
  ): Promise<void> {
    await this.ensureInitialized();
    if (cards.length === 0) return;
    const now = this.now().toISOString();
    const events: ProjectWikiMaintenanceEvent[] = cards.map((card) => ({
      op: "processed",
      key: maintenanceKeyForCard(card),
      cardId: card.id,
      relativePath: card.relativePath,
      processedAt: now,
      traceId,
    }));
    await appendFile(
      this.maintenanceStatePath,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async listMarkdownFiles(): Promise<Array<{ absolutePath: string; content: string }>> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolutePath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "traces") continue;
          await walk(absolutePath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(absolutePath);
        }
      }
    };
    await walk(this.rootDir);
    const output: Array<{ absolutePath: string; content: string }> = [];
    for (const file of files) {
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        output.push({ absolutePath: file, content: await readFile(file, "utf8") });
      } catch {
        // skip unreadable files
      }
    }
    return output;
  }

  private get maintenanceStatePath(): string {
    return join(this.rootDir, "state", "wiki-maintenance.jsonl");
  }

  private async readPendingMaintenanceEvents(): Promise<ProjectWikiMaintenanceEvent[]> {
    const path = this.maintenanceStatePath;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const pending = new Map<string, ProjectWikiMaintenanceEvent>();
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as ProjectWikiMaintenanceEvent;
        if (!event || !event.key) continue;
        if (event.op === "enqueue" && event.relativePath) {
          pending.set(event.key, event);
        } else if (event.op === "processed") {
          pending.delete(event.key);
        }
      } catch {
        // Ignore malformed queue rows; the maintainer will keep processing valid rows.
      }
    }
    return [...pending.values()]
      .sort((left, right) => (left.queuedAt ?? "").localeCompare(right.queuedAt ?? ""));
  }

  private async readSourceCardRecord(relativePath: string): Promise<ProjectWikiSourceCardRecord | undefined> {
    const file = await this.readRelative(relativePath);
    if (!file) return undefined;
    return parseSourceCardRecord(file.relativePath, file.content);
  }

  private resolveInsideRoot(relativePath: string): string {
    const target = resolve(this.rootDir, relativePath);
    const rootWithSep = this.rootDir.endsWith("/") ? this.rootDir : `${this.rootDir}/`;
    if (target !== this.rootDir && !target.startsWith(rootWithSep)) {
      throw new Error(`Path escapes ProjectWiki root: ${relativePath}`);
    }
    return target;
  }

  private buildHomeMarkdown(): string {
    return renderMarkdown({
      frontmatter: {
        type: "project_wiki_home",
        pageId: "home",
        title: "Project Home",
        description: "Project-specific homepage maintained from ProjectWiki source cards.",
        projectRoot: this.projectRoot,
        updatedAt: this.now().toISOString(),
        sourceCardIds: [],
      },
      title: "Project Home",
      body: [
        "ProjectWiki has not built a project-specific homepage yet.",
        "",
        "After project material is indexed, the maintainer will turn source cards into a concise project homepage with:",
        "",
        "- the project's current identity and purpose",
        "- the most important current status",
        "- key decisions, preferences, or risks",
        "- links to the most useful ProjectWiki pages or source cards",
      ].join("\n"),
    });
  }

  private async repairHomeMarkdown(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.homePath, "utf8");
    } catch {
      return;
    }
    const parsed = parseMarkdown(content);
    if (readString(parsed.frontmatter.type) !== "project_wiki_home") return;
    const body = parsed.body;
    const stale =
      body.includes("wiki/collaboration-context.md") ||
      (
        body.includes("ProjectWiki is the unified project context layer")
        && body.includes("## Wiki Pages")
        && body.includes("source_cards/repo/")
      );
    if (!stale) return;
    await writeFile(this.homePath, this.buildHomeMarkdown(), { encoding: "utf8", mode: 0o600 });
  }

  private async repairWikiPageEnvelope(pagePath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(pagePath, "utf8");
    } catch {
      return;
    }
    const outer = parseMarkdown(content);
    const title = readString(outer.frontmatter.title) || inferTitle(outer.body) || basename(pagePath, ".md");
    const body = stripLeadingTitle(outer.body, title);
    if (!body.startsWith("---")) return;
    const inner = parseMarkdown(body);
    if (inner.body.trim() === body) return;
    const cleanedBody = stripLeadingTitle(inner.body, title);
    if (!cleanedBody) return;
    await writeFile(
      pagePath,
      renderMarkdown({
        frontmatter: outer.frontmatter,
        title,
        body: cleanedBody,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async repairSourceCards(): Promise<void> {
    const sourceCardPaths: string[] = [];
    for (const sourceType of PROJECT_WIKI_SOURCE_TYPES) {
      const dir = join(this.rootDir, "source_cards", sourceType);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          sourceCardPaths.push(join(dir, entry.name));
        }
      }
    }

    for (const sourceCardPath of sourceCardPaths) {
      await this.repairSourceCard(sourceCardPath);
    }
  }

  private async repairSourceCard(sourceCardPath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(sourceCardPath, "utf8");
    } catch {
      return;
    }
    const parsed = parseMarkdown(content);
    if (readString(parsed.frontmatter.type) !== "source_card") return;
    const sourceRefs = readSourceRefs(parsed.frontmatter.sourceRefs);
    let changed = false;
    const repairedRefs: ProjectWikiSourceRef[] = [];
    for (const ref of sourceRefs) {
      let repaired = ref;
      if (ref.kind === "transcript" && ref.sessionId) {
        if (!ref.path) {
          const transcriptPath = this.resolveSiblingTranscriptPath(ref.sessionId);
          if (transcriptPath) {
            repaired = { ...ref, path: transcriptPath };
            changed = true;
          }
        } else {
          const transcriptPath = await resolveSubagentTranscriptPathForSourceRef(ref, ref.path);
          if (transcriptPath && transcriptPath !== ref.path) {
            repaired = { ...ref, path: transcriptPath };
            changed = true;
          }
        }
      }
      repairedRefs.push(repaired);
    }

    const relativePath = toPosix(relative(this.rootDir, sourceCardPath));
    const pathSourceType = readSourceType(relativePath.split("/")[1]);
    const frontmatterSourceType = readSourceType(parsed.frontmatter.sourceType);
    const sourceType = pathSourceType ?? frontmatterSourceType;
    if (pathSourceType && pathSourceType !== frontmatterSourceType) {
      changed = true;
    }
    let status = normalizeSourceCardStatus(parsed.frontmatter.status);
    let statusReason = optionalString(parsed.frontmatter.statusReason);
    const consistencyIssue = sourceType
      ? sourceCardConsistencyIssue(sourceType, repairedRefs)
      : undefined;
    if (consistencyIssue && status === "active") {
      status = "stale";
      statusReason = consistencyIssue;
      changed = true;
    } else if (consistencyIssue && !statusReason) {
      statusReason = consistencyIssue;
      changed = true;
    }
    if (status === "stale" && statusReason?.startsWith("Source reference is no longer fresh:") && !consistencyIssue) {
      const freshnessIssue = await findSourceRefsFreshnessIssue(repairedRefs);
      if (freshnessIssue) {
        if (statusReason !== freshnessIssue) {
          statusReason = freshnessIssue;
          changed = true;
        }
      } else {
        status = "active";
        statusReason = "";
        changed = true;
      }
    }
    if (!changed) return;

    const title = readString(parsed.frontmatter.title) || inferTitle(parsed.body);
    const description = readString(parsed.frontmatter.description);
    const summary = extractMarkdownSection(parsed.body, "Summary");
    const id = readString(parsed.frontmatter.id);
    const createdAt = readString(parsed.frontmatter.createdAt);
    const updatedAt = readString(parsed.frontmatter.updatedAt);
    if (!sourceType || !title || !description || !summary || !id || !createdAt || !updatedAt) return;

    await writeFile(
      sourceCardPath,
      renderSourceCardMarkdown({
        id,
        sourceType,
        title,
        description,
        summary,
        tags: normalizeStringArray(parsed.frontmatter.tags),
        status,
        statusReason,
        importance: typeof parsed.frontmatter.importance === "number" ? parsed.frontmatter.importance : 0,
        evidenceLevel: readEvidenceLevel(parsed.frontmatter.evidenceLevel),
        confidence: readConfidence(parsed.frontmatter.confidence),
        qualitySignals: normalizeStringArray(parsed.frontmatter.qualitySignals),
        sourceRefs: repairedRefs,
        createdAt,
        updatedAt,
        relativePath,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private resolveSiblingTranscriptPath(sessionId: string): string | undefined {
    const candidate = resolve(
      this.rootDir,
      "..",
      "chats",
      `${sanitizeSessionIdForPath(sessionId)}.jsonl`,
    );
    return existsSync(candidate) ? candidate : undefined;
  }
}

function parseSourceCardRecord(relativePath: string, content: string): ProjectWikiSourceCardRecord | undefined {
  const parsed = parseMarkdown(content);
  if (readString(parsed.frontmatter.type) !== "source_card") return undefined;
  const id = readString(parsed.frontmatter.id);
  const sourceType = readSourceType(parsed.frontmatter.sourceType)
    ?? readSourceType(relativePath.split("/")[1]);
  const title = readString(parsed.frontmatter.title) || inferTitle(parsed.body);
  const description = readString(parsed.frontmatter.description);
  const summary = extractMarkdownSection(parsed.body, "Summary");
  const createdAt = readString(parsed.frontmatter.createdAt);
  const updatedAt = readString(parsed.frontmatter.updatedAt);
  if (!id || !sourceType || !title || !description || !summary || !createdAt || !updatedAt) {
    return undefined;
  }
  return {
    id,
    sourceType,
    title,
    description,
    summary,
    tags: normalizeStringArray(parsed.frontmatter.tags),
    status: normalizeSourceCardStatus(parsed.frontmatter.status),
    statusReason: optionalString(parsed.frontmatter.statusReason),
    importance: typeof parsed.frontmatter.importance === "number" ? parsed.frontmatter.importance : 0,
    evidenceLevel: readEvidenceLevel(parsed.frontmatter.evidenceLevel),
    confidence: readConfidence(parsed.frontmatter.confidence),
    qualitySignals: normalizeStringArray(parsed.frontmatter.qualitySignals),
    sourceRefs: readSourceRefs(parsed.frontmatter.sourceRefs),
    createdAt,
    updatedAt,
    relativePath,
  };
}

function isCatalogMarkdownPath(relativePath: string): boolean {
  if (relativePath === "home.md") return true;
  if (relativePath.startsWith("source_cards/")) return true;
  return PROJECT_WIKI_PAGE_IDS.some((pageId) => relativePath === `wiki/${pageId}.md`);
}

function isCoreCatalogMarkdownPath(relativePath: string): boolean {
  return relativePath === "home.md"
    || PROJECT_WIKI_PAGE_IDS.some((pageId) => relativePath === `wiki/${pageId}.md`);
}

function compareCatalogPaths(left: string, right: string): number {
  const leftRank = catalogPathRank(left);
  const rightRank = catalogPathRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.startsWith("wiki/") && right.startsWith("wiki/")) {
    return wikiPageOrder(left) - wikiPageOrder(right);
  }
  return left.localeCompare(right);
}

function catalogPathRank(relativePath: string): number {
  if (relativePath === "home.md") return 0;
  if (relativePath.startsWith("wiki/")) return 1;
  if (relativePath.startsWith("source_cards/")) return 2;
  return 3;
}

function wikiPageOrder(relativePath: string): number {
  const pageId = relativePath.replace(/^wiki\//, "").replace(/\.md$/, "") as ProjectWikiWikiPageId;
  const index = PROJECT_WIKI_PAGE_IDS.indexOf(pageId);
  return index >= 0 ? index : PROJECT_WIKI_PAGE_IDS.length;
}

async function observeSourceCardChange(
  card: ProjectWikiSourceCardRecord,
  options: { forceRecheck?: boolean } = {},
): Promise<ProjectWikiSourceChangeEvent | undefined> {
  const originalRefs = card.sourceRefs ?? [];
  const suggestedSourceRefs = [...originalRefs];
  const changes: ProjectWikiSourceRefChange[] = [];
  const consistencyIssue = sourceCardConsistencyIssue(card.sourceType, originalRefs);
  if (consistencyIssue) {
    changes.push({
      kind: "inconsistent",
      reason: consistencyIssue,
      sourceRef: originalRefs[0] ?? { kind: "source_card", label: card.id },
    });
  }

  for (let index = 0; index < originalRefs.length; index += 1) {
    const ref = originalRefs[index]!;
    const change = await observeSourceRefChange(ref);
    if (!change) continue;
    changes.push(change);
    if (change.currentSourceRef) suggestedSourceRefs[index] = change.currentSourceRef;
  }

  if (changes.length === 0 && options.forceRecheck) {
    const recheck = await sourceRefRecheckEvidence(originalRefs[0]);
    changes.push(recheck ?? {
      kind: "recheck",
      reason: "Source card is currently marked stale and needs model re-evaluation, but no current source evidence could be read.",
      sourceRef: originalRefs[0] ?? { kind: "source_card", label: card.id },
    });
    if (recheck?.currentSourceRef) suggestedSourceRefs[0] = recheck.currentSourceRef;
  }

  if (changes.length === 0) return undefined;
  return {
    sourceCard: card,
    sourceCardId: card.id,
    relativePath: card.relativePath,
    sourceType: card.sourceType,
    observedAt: "",
    changes,
    suggestedSourceRefs,
  };
}

async function sourceRefRecheckEvidence(ref: ProjectWikiSourceRef | undefined): Promise<ProjectWikiSourceRefChange | undefined> {
  if (!ref || !isFreshnessCheckedSourceRef(ref)) return undefined;
  const refPath = ref.path?.trim();
  if (!refPath) return undefined;
  let info;
  try {
    info = await stat(refPath);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  if (ref.kind === "transcript" && ref.turnId) {
    const evidence = await transcriptSourceRefCurrentEvidence(ref, refPath);
    if (!evidence) return undefined;
    return {
      kind: "recheck",
      reason: "Source card is currently marked stale; current transcript evidence is available for model re-evaluation.",
      sourceRef: ref,
      currentSourceRef: evidence.sourceRef,
      currentEvidence: evidence.evidence,
    };
  }
  let content: string;
  try {
    content = await readFile(refPath, "utf8");
  } catch {
    return undefined;
  }
  return {
    kind: "recheck",
    reason: "Source card is currently marked stale; current file evidence is available for model re-evaluation.",
    sourceRef: ref,
    currentSourceRef: isContentHashCheckedSourceRef(ref)
      ? { ...ref, contentHash: hashText(content) }
      : ref,
    currentEvidence: truncateText(content, 6_000),
  };
}

async function observeSourceRefChange(ref: ProjectWikiSourceRef): Promise<ProjectWikiSourceRefChange | undefined> {
  if (!isFreshnessCheckedSourceRef(ref)) return undefined;
  const refPath = ref.path?.trim();
  if (!refPath) return undefined;
  let info;
  try {
    info = await stat(refPath);
  } catch {
    return {
      kind: "missing",
      reason: `${formatSourceRefForFreshness(ref)} is missing.`,
      sourceRef: ref,
    };
  }
  if (!info.isFile()) {
    return {
      kind: "unreadable",
      reason: `${formatSourceRefForFreshness(ref)} is not a readable file.`,
      sourceRef: ref,
    };
  }
  if (ref.kind === "transcript" && ref.contentHash) {
    return await observeTranscriptSourceRefChange(ref, refPath);
  }
  if (!isContentHashCheckedSourceRef(ref) || !ref.contentHash) return undefined;
  let content: string;
  try {
    content = await readFile(refPath, "utf8");
  } catch {
    return {
      kind: "unreadable",
      reason: `${formatSourceRefForFreshness(ref)} could not be read.`,
      sourceRef: ref,
    };
  }
  const currentHash = hashText(content);
  if (currentHash === normalizeContentHash(ref.contentHash)) return undefined;
  return {
    kind: "modified",
    reason: `${formatSourceRefForFreshness(ref)} content changed.`,
    sourceRef: ref,
    currentSourceRef: { ...ref, contentHash: currentHash },
    currentEvidence: truncateText(content, 6_000),
  };
}

async function transcriptSourceRefCurrentEvidence(
  ref: ProjectWikiSourceRef,
  refPath: string,
  seenPaths = new Set<string>(),
): Promise<{ sourceRef: ProjectWikiSourceRef; evidence: string } | undefined> {
  if (!ref.turnId) return undefined;
  seenPaths.add(refPath);
  let transcript;
  try {
    transcript = await readTranscript(refPath);
  } catch {
    return undefined;
  }
  const messages = transcriptMessagesForSourceRef(transcript.entries, ref);
  if (messages.length === 0) {
    const sidechainPath = resolveSubagentTranscriptPath(ref, refPath, transcript.entries);
    if (sidechainPath && !seenPaths.has(sidechainPath)) {
      return transcriptSourceRefCurrentEvidence({ ...ref, path: sidechainPath }, sidechainPath, seenPaths);
    }
    return undefined;
  }
  const digest = canonicalMessagesToFreshnessDigest(messages, 16_000);
  return {
    sourceRef: { ...ref, path: refPath, contentHash: hashText(digest) },
    evidence: digest,
  };
}

async function observeTranscriptSourceRefChange(
  ref: ProjectWikiSourceRef,
  refPath: string,
  seenPaths = new Set<string>(),
): Promise<ProjectWikiSourceRefChange | undefined> {
  if (!ref.turnId) return undefined;
  seenPaths.add(refPath);
  let transcript;
  try {
    transcript = await readTranscript(refPath);
  } catch {
    return {
      kind: "unreadable",
      reason: `${formatSourceRefForFreshness(ref)} could not be read.`,
      sourceRef: ref,
    };
  }
  const messages = transcriptMessagesForSourceRef(transcript.entries, ref);
  if (messages.length === 0) {
    const sidechainPath = resolveSubagentTranscriptPath(ref, refPath, transcript.entries);
    if (sidechainPath && !seenPaths.has(sidechainPath)) {
      const sidechainChange = await observeTranscriptSourceRefChange(ref, sidechainPath, seenPaths);
      if (!sidechainChange) {
        return {
          kind: "modified",
          reason: `${formatSourceRefForFreshness(ref)} moved to sidechain transcript.`,
          sourceRef: ref,
          currentSourceRef: { ...ref, path: sidechainPath },
        };
      }
      return {
        ...sidechainChange,
        sourceRef: ref,
        currentSourceRef: {
          ...(sidechainChange.currentSourceRef ?? ref),
          path: sidechainPath,
        },
      };
    }
    const parseIssue = transcript.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    return {
      kind: parseIssue ? "unreadable" : "missing",
      reason: parseIssue
        ? `${formatSourceRefForFreshness(ref)} could not be parsed: ${parseIssue.message}`
        : `${formatSourceRefForFreshness(ref)} turn ${ref.turnId} was not found.`,
      sourceRef: ref,
    };
  }
  const digest = canonicalMessagesToFreshnessDigest(messages, 16_000);
  const currentHash = hashText(digest);
  if (currentHash === normalizeContentHash(ref.contentHash ?? "")) return undefined;
  return {
    kind: "modified",
    reason: `${formatSourceRefForFreshness(ref)} content changed.`,
    sourceRef: ref,
    currentSourceRef: { ...ref, path: refPath, contentHash: currentHash },
    currentEvidence: digest,
  };
}

async function findSourceCardFreshnessIssue(card: ProjectWikiSourceCardRecord): Promise<string | undefined> {
  return findSourceRefsFreshnessIssue(card.sourceRefs ?? []);
}

async function findSourceRefsFreshnessIssue(sourceRefs: ProjectWikiSourceRef[]): Promise<string | undefined> {
  const issues: string[] = [];
  for (const ref of sourceRefs) {
    const issue = await sourceRefFreshnessIssue(ref);
    if (issue) issues.push(issue);
    if (issues.length >= 3) break;
  }
  if (issues.length === 0) return undefined;
  const suffix = issues.length > 1 ? `; ${issues.slice(1).join("; ")}` : "";
  return `Source reference is no longer fresh: ${issues[0]}${suffix}`;
}

async function sourceRefFreshnessIssue(ref: ProjectWikiSourceRef): Promise<string | undefined> {
  if (!isFreshnessCheckedSourceRef(ref)) return undefined;
  const refPath = ref.path?.trim();
  if (!refPath) return undefined;
  let info;
  try {
    info = await stat(refPath);
  } catch {
    return `${formatSourceRefForFreshness(ref)} is missing.`;
  }
  if (!info.isFile()) {
    return `${formatSourceRefForFreshness(ref)} is not a readable file.`;
  }
  if (ref.kind === "transcript" && ref.contentHash) {
    return await transcriptSourceRefFreshnessIssue(ref, refPath);
  }
  if (!isContentHashCheckedSourceRef(ref) || !ref.contentHash) return undefined;
  let content: string;
  try {
    content = await readFile(refPath, "utf8");
  } catch {
    return `${formatSourceRefForFreshness(ref)} could not be read.`;
  }
  if (hashText(content) !== normalizeContentHash(ref.contentHash)) {
    return `${formatSourceRefForFreshness(ref)} content changed.`;
  }
  return undefined;
}

async function transcriptSourceRefFreshnessIssue(
  ref: ProjectWikiSourceRef,
  refPath: string,
  seenPaths = new Set<string>(),
): Promise<string | undefined> {
  if (!ref.turnId) return undefined;
  seenPaths.add(refPath);
  let transcript;
  try {
    transcript = await readTranscript(refPath);
  } catch {
    return `${formatSourceRefForFreshness(ref)} could not be read.`;
  }
  const messages = transcriptMessagesForSourceRef(transcript.entries, ref);
  if (messages.length === 0) {
    const sidechainPath = resolveSubagentTranscriptPath(ref, refPath, transcript.entries);
    if (sidechainPath && !seenPaths.has(sidechainPath)) {
      return transcriptSourceRefFreshnessIssue(ref, sidechainPath, seenPaths);
    }
    const parseIssue = transcript.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (parseIssue) {
      return `${formatSourceRefForFreshness(ref)} could not be parsed: ${parseIssue.message}`;
    }
    return `${formatSourceRefForFreshness(ref)} turn ${ref.turnId} was not found.`;
  }
  const digest = canonicalMessagesToFreshnessDigest(messages, 16_000);
  if (hashText(digest) !== normalizeContentHash(ref.contentHash ?? "")) {
    return `${formatSourceRefForFreshness(ref)} content changed.`;
  }
  return undefined;
}

async function resolveSubagentTranscriptPathForSourceRef(
  ref: ProjectWikiSourceRef,
  refPath: string,
): Promise<string | undefined> {
  if (ref.kind !== "transcript" || !ref.turnId) return undefined;
  let parentTranscript;
  try {
    parentTranscript = await readTranscript(refPath);
  } catch {
    return undefined;
  }
  if (transcriptMessagesForSourceRef(parentTranscript.entries, ref).length > 0) return undefined;
  const sidechainPath = resolveSubagentTranscriptPath(ref, refPath, parentTranscript.entries);
  if (!sidechainPath || sidechainPath === refPath) return undefined;
  let sidechainTranscript;
  try {
    sidechainTranscript = await readTranscript(sidechainPath);
  } catch {
    return undefined;
  }
  return transcriptMessagesForSourceRef(sidechainTranscript.entries, ref).length > 0
    ? sidechainPath
    : undefined;
}

function resolveSubagentTranscriptPath(
  ref: ProjectWikiSourceRef,
  parentTranscriptPath: string,
  entries: AgentTranscriptEntry[],
): string | undefined {
  const subagentId = subagentIdFromSourceRef(ref);
  if (!subagentId && !ref.sessionId) return undefined;
  for (const entry of entries) {
    if (entry.type !== "subagent_started") continue;
    const matchesSession = Boolean(ref.sessionId && entry.subagentSessionId === ref.sessionId);
    const matchesId = Boolean(subagentId && entry.subagentId === subagentId);
    if (!matchesSession && !matchesId) continue;
    if (!entry.transcriptRelativePath) continue;
    return resolve(dirname(parentTranscriptPath), entry.transcriptRelativePath);
  }
  return undefined;
}

function subagentIdFromSourceRef(ref: ProjectWikiSourceRef): string | undefined {
  if (ref.sessionId) {
    const marker = "::sub::";
    const index = ref.sessionId.lastIndexOf(marker);
    if (index >= 0) {
      const subagentId = ref.sessionId.slice(index + marker.length).trim();
      if (subagentId) return subagentId;
    }
  }
  if (ref.turnId?.endsWith("-t0")) {
    const subagentId = ref.turnId.slice(0, -"-t0".length).trim();
    if (subagentId) return subagentId;
  }
  return undefined;
}

function transcriptMessagesForSourceRef(
  entries: AgentTranscriptEntry[],
  ref: ProjectWikiSourceRef,
): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const entry of entries) {
    if (entry.turnId !== ref.turnId) continue;
    if (ref.sessionId && entry.sessionId !== ref.sessionId) continue;
    if (entry.type === "accepted_input") {
      messages.push(...entry.messages);
    } else if (
      entry.type === "assistant_message"
      || entry.type === "tool_result_message"
      || entry.type === "durable_message"
    ) {
      messages.push(entry.message);
    }
  }
  return messages;
}

function canonicalMessagesToFreshnessDigest(messages: CanonicalMessage[], maxChars: number): string {
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

function isFreshnessCheckedSourceRef(ref: ProjectWikiSourceRef): boolean {
  return [
    "repo_file",
    "legacy_memory",
    "transcript",
    "tool_result_reference",
    "media_reference",
  ].includes(ref.kind);
}

function isContentHashCheckedSourceRef(ref: ProjectWikiSourceRef): boolean {
  return ref.kind === "repo_file" || ref.kind === "legacy_memory";
}

function formatSourceRefForFreshness(ref: ProjectWikiSourceRef): string {
  const label = ref.label ? ` ${ref.label}` : "";
  const refPath = ref.path ? ` at ${ref.path}` : "";
  return `${ref.kind}${label}${refPath}`;
}

function sourceCardConsistencyIssue(
  sourceType: ProjectWikiSourceType,
  sourceRefs: ProjectWikiSourceRef[],
): string | undefined {
  if (sourceRefs.length === 0) return undefined;
  if (sourceType === "repo" && !sourceRefs.some((ref) => ref.kind === "repo" || ref.kind === "repo_file")) {
    return `Repo source card is not backed by repository source refs; found ${formatSourceRefKinds(sourceRefs)}.`;
  }
  if (sourceType === "memory" && !sourceRefs.some((ref) => ref.kind === "legacy_memory")) {
    return `Memory source card is not backed by imported memory source refs; found ${formatSourceRefKinds(sourceRefs)}.`;
  }
  return undefined;
}

function formatSourceRefKinds(sourceRefs: ProjectWikiSourceRef[]): string {
  const kinds = [...new Set(sourceRefs.map((ref) => ref.kind).filter(Boolean))];
  return kinds.length > 0 ? kinds.join(", ") : "unknown refs";
}

function normalizeContentHash(value: string): string {
  return value.trim().replace(/^sha256:/i, "");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringifyTracePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return JSON.stringify({
      unserializable: true,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2);
  }
}

function isReusableSourceCard(
  existing: ProjectWikiSourceCardRecord,
  draft: ProjectWikiSourceCardDraft,
): boolean {
  if (existing.sourceType !== draft.sourceType) return false;
  const existingTitle = normalizeComparableText(existing.title);
  const draftTitle = normalizeComparableText(draft.title);
  if (!existingTitle || !draftTitle) return false;
  const existingSummary = normalizeComparableText(existing.summary);
  const draftSummary = normalizeComparableText(draft.summary);
  if (existingTitle === draftTitle && existingSummary === draftSummary) return true;
  if (existingTitle !== draftTitle) return false;
  return tokenSimilarity(existingSummary, draftSummary) >= 0.82;
}

function preferLongerText(left: string, right: string): string {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  return normalizedRight.length > normalizedLeft.length ? normalizedRight : normalizedLeft;
}

function mergeStringArrays(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])]
    .map((item) => item.trim())
    .filter(Boolean))];
}

function mergeEvidenceLevel(
  left: ProjectWikiSourceCardRecord["evidenceLevel"],
  right: ProjectWikiSourceCardDraft["evidenceLevel"],
): ProjectWikiSourceCardRecord["evidenceLevel"] {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  if (!left) return right;
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function mergeConfidence(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function mergeSourceCardStatus(
  left: ProjectWikiSourceCardRecord["status"],
  right: ProjectWikiSourceCardDraft["status"],
): ProjectWikiSourceCardRecord["status"] {
  const leftStatus = left ?? "active";
  const rightStatus = right ?? "active";
  if (leftStatus === "conflict" || rightStatus === "conflict") return "conflict";
  if (leftStatus === "stale" || rightStatus === "stale") return "stale";
  if (leftStatus === "active" || rightStatus === "active") return "active";
  return "draft";
}

function mergeSourceCardStatusReason(
  existing: ProjectWikiSourceCardRecord,
  draft: ProjectWikiSourceCardDraft,
  status: ProjectWikiSourceCardRecord["status"],
): string | undefined {
  if (!status || status === "active") return undefined;
  if (status === (draft.status ?? "active")) return draft.statusReason;
  if (status === (existing.status ?? "active")) return existing.statusReason;
  return draft.statusReason ?? existing.statusReason;
}

function mergeSourceRefs(
  left: ProjectWikiSourceRef[] | undefined,
  right: ProjectWikiSourceRef[] | undefined,
): ProjectWikiSourceRef[] {
  const seen = new Set<string>();
  const refs: ProjectWikiSourceRef[] = [];
  for (const ref of [...(left ?? []), ...(right ?? [])]) {
    const key = [
      ref.kind,
      ref.path ?? "",
      ref.sessionId ?? "",
      ref.turnId ?? "",
      ref.messageId ?? "",
      ref.label,
      ref.contentHash ?? "",
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[`*_~>#:[\]()"',.;!?，。！？、：；（）【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = comparableTokenSet(left);
  const rightTokens = comparableTokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

function comparableTokenSet(value: string): Set<string> {
  return new Set(value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2));
}

type SourceCardSummary = {
  id: string;
  relativePath: string;
  title: string;
  status: NonNullable<ProjectWikiSourceCardRecord["status"]>;
  statusReason?: string;
};

function buildSourceCardSummaryIndex(
  rootDir: string,
  files: Array<{ absolutePath: string; content: string }>,
): Map<string, SourceCardSummary> {
  const byId = new Map<string, SourceCardSummary>();
  for (const file of files) {
    const relativePath = toPosix(relative(rootDir, file.absolutePath));
    if (!relativePath.startsWith("source_cards/")) continue;
    const parsed = parseMarkdown(file.content);
    if (readString(parsed.frontmatter.type) !== "source_card") continue;
    const id = readString(parsed.frontmatter.id);
    if (!id) continue;
    byId.set(id, {
      id,
      relativePath,
      title: readString(parsed.frontmatter.title) || inferTitle(parsed.body) || basename(relativePath),
      status: normalizeSourceCardStatus(parsed.frontmatter.status),
      statusReason: optionalString(parsed.frontmatter.statusReason),
    });
  }
  return byId;
}

function computeSourceHealth(
  sourceCardIds: string[],
  sourceCardsById: Map<string, SourceCardSummary>,
): ProjectWikiSourceHealth {
  const health: ProjectWikiSourceHealth = {
    total: sourceCardIds.length,
    active: 0,
    stale: 0,
    conflict: 0,
    draft: 0,
    missing: 0,
    warnings: [],
  };
  for (const id of sourceCardIds) {
    const card = sourceCardsById.get(id);
    if (!card) {
      health.missing += 1;
      health.warnings.push(`Missing source card ${id}.`);
      continue;
    }
    const status = card.status ?? "active";
    if (status === "stale") {
      health.stale += 1;
      health.warnings.push(formatSourceHealthWarning(`${card.title} is stale`, card.statusReason));
    } else if (status === "conflict") {
      health.conflict += 1;
      health.warnings.push(formatSourceHealthWarning(`${card.title} is marked conflict`, card.statusReason));
    } else if (status === "draft") {
      health.draft += 1;
    } else {
      health.active += 1;
    }
  }
  return {
    ...health,
    warnings: health.warnings.slice(0, 8),
  };
}

function formatSourceHealthWarning(prefix: string, reason?: string): string {
  if (!reason) return `${prefix}.`;
  const trimmed = reason.trim();
  return `${prefix}: ${/[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`}`;
}

function formatSourceCardQuality(card: ProjectWikiSourceCardRecord): string[] {
  const lines: string[] = [];
  if (card.evidenceLevel) lines.push(`- evidenceLevel: ${card.evidenceLevel}`);
  if (card.confidence !== undefined) lines.push(`- confidence: ${card.confidence.toFixed(2)}`);
  for (const signal of card.qualitySignals ?? []) {
    lines.push(`- signal: ${signal}`);
  }
  return lines.length > 0 ? ["", "## Quality", ...lines] : [];
}

function renderSourceCardMarkdown(card: ProjectWikiSourceCardRecord): string {
  return renderMarkdown({
    frontmatter: {
      id: card.id,
      type: "source_card",
      sourceType: card.sourceType,
      title: card.title,
      description: card.description,
      tags: card.tags ?? [],
      status: card.status ?? "active",
      statusReason: card.statusReason ?? "",
      importance: card.importance ?? 0,
      evidenceLevel: card.evidenceLevel ?? "",
      confidence: card.confidence ?? "",
      qualitySignals: card.qualitySignals ?? [],
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      sourceRefs: card.sourceRefs ?? [],
    },
    title: card.title,
    body: [
      `> ${card.description}`,
      "",
      "## Summary",
      card.summary,
      ...formatSourceCardQuality(card),
      "",
      "## Source References",
      ...(card.sourceRefs ?? []).map((ref) => {
        const parts = [
          ref.kind,
          ref.label,
          ref.path ? `path=${ref.path}` : "",
          ref.sessionId ? `session=${ref.sessionId}` : "",
          ref.turnId ? `turn=${ref.turnId}` : "",
          ref.messageId ? `message=${ref.messageId}` : "",
          ref.range ? `range=${formatSourceRange(ref.range)}` : "",
          ref.contentHash ? `hash=${ref.contentHash}` : "",
        ].filter(Boolean);
        return `- ${parts.join(" | ")}`;
      }),
    ].join("\n"),
  });
}

function renderMarkdown(input: {
  frontmatter: Record<string, unknown>;
  title: string;
  body: string;
}): string {
  return [
    "---",
    renderFrontmatter(input.frontmatter),
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

function renderFrontmatter(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, child]) => renderFrontmatterValue(key, child))
    .join("\n");
}

function renderFrontmatterValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return [
      `${key}:`,
      ...value.map((item) => {
        if (typeof item === "object" && item !== null) {
          return `  - ${JSON.stringify(item)}`;
        }
        return `  - ${JSON.stringify(item)}`;
      }),
    ].join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return `${key}: ${JSON.stringify(value)}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}: ${String(value)}`;
  }
  return `${key}: ${JSON.stringify(String(value ?? ""))}`;
}

export function parseMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: {}, body: content };
  }
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\s+/, "");
  return { frontmatter: parseSimpleFrontmatter(raw), body };
}

function parseSimpleFrontmatter(raw: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (!value) {
      const items: unknown[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const itemMatch = /^\s*-\s+(.*)$/.exec(lines[cursor]!);
        if (!itemMatch) break;
        items.push(parseFrontmatterScalar(itemMatch[1]!.trim()));
        cursor += 1;
      }
      if (items.length > 0) {
        output[key] = items;
        index = cursor - 1;
      } else {
        output[key] = "";
      }
      continue;
    }
    if (value === "[]") {
      output[key] = value === "[]" ? [] : "";
      continue;
    }
    output[key] = parseFrontmatterScalar(value);
  }
  return output;
}

function parseFrontmatterScalar(value: string): unknown {
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function readSourceType(value: unknown): ProjectWikiSourceType | undefined {
  return PROJECT_WIKI_SOURCE_TYPES.includes(value as ProjectWikiSourceType)
    ? value as ProjectWikiSourceType
    : undefined;
}

function readSourceRefs(value: unknown): ProjectWikiSourceRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const kind = readString(item.kind);
      const label = readString(item.label);
      if (!kind || !label) return undefined;
      const ref: ProjectWikiSourceRef = {
        kind,
        label,
      };
      const path = optionalString(item.path);
      const sessionId = optionalString(item.sessionId);
      const turnId = optionalString(item.turnId);
      const messageId = optionalString(item.messageId);
      const excerpt = optionalString(item.excerpt);
      const range = readSourceRange(item.range);
      const contentHash = optionalString(item.contentHash);
      if (path) ref.path = path;
      if (sessionId) ref.sessionId = sessionId;
      if (turnId) ref.turnId = turnId;
      if (messageId) ref.messageId = messageId;
      if (excerpt) ref.excerpt = excerpt;
      if (range) ref.range = range;
      if (contentHash) ref.contentHash = contentHash;
      return ref;
    })
    .filter((item): item is ProjectWikiSourceRef => Boolean(item));
}

function readSourceRange(value: unknown): ProjectWikiSourceRange | undefined {
  if (!isRecord(value)) return undefined;
  const range: ProjectWikiSourceRange = {};
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

function formatSourceRange(range: ProjectWikiSourceRange): string {
  if (range.startLine !== undefined && range.endLine !== undefined) {
    return `${range.startLine}-${range.endLine}`;
  }
  if (range.startLine !== undefined) return `${range.startLine}`;
  if (range.messageIndex !== undefined) return `message:${range.messageIndex}`;
  return "";
}

function normalizeSourceCardStatus(value: unknown): NonNullable<ProjectWikiSourceCardRecord["status"]> {
  return value === "stale" || value === "conflict" || value === "draft"
    ? value
    : "active";
}

function extractMarkdownSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const headingLine = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === headingLine);
  if (start < 0) return "";
  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^##\s+/.test(line.trim())) break;
    section.push(line);
  }
  return section.join("\n").trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferTitle(body: string): string {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() ?? "";
}

function stripLeadingTitle(body: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body
    .trim()
    .replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), "")
    .trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function readEvidenceLevel(value: unknown): ProjectWikiSourceCardRecord["evidenceLevel"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function readConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function conflictKey(topic: string, sourceCardIds: string[]): string {
  return JSON.stringify([
    topic.trim().toLowerCase(),
    [...sourceCardIds].sort(),
  ]);
}

function maintenanceKeyForCard(card: ProjectWikiSourceCardRecord): string {
  return card.id || card.relativePath;
}

async function appendJsonLines(path: string, records: unknown[]): Promise<void> {
  if (records.length === 0) return;
  let prefix = "";
  try {
    const existing = await readFile(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch {
    // Missing files are expected for the first append.
  }
  await appendFile(
    path,
    `${prefix}${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

function timestampForPath(iso: string): string {
  return iso.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}
