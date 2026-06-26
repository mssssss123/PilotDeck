import type {
  ProjectWikiPageId,
  ProjectWikiSourceType,
} from "./types.js";

export type ProjectWikiIndexOutput = {
  cards?: Array<{
    sourceType?: ProjectWikiSourceType;
    title?: string;
    description?: string;
    summary?: string;
    tags?: string[];
    status?: "active" | "stale" | "conflict" | "draft";
    statusReason?: string;
    importance?: number;
    evidenceLevel?: "low" | "medium" | "high";
    confidence?: number;
    qualitySignals?: string[];
    sourceRefs?: Array<{
      kind?: string;
      label?: string;
      path?: string;
      sessionId?: string;
      turnId?: string;
      messageId?: string;
      excerpt?: string;
      range?: {
        startLine?: number;
        endLine?: number;
        messageIndex?: number;
      };
      contentHash?: string;
    }>;
  }>;
  skipped?: Array<{ reason?: string; source?: string }>;
};

export type ProjectWikiMaintainOutput = {
  pages?: Array<{
    pageId?: ProjectWikiPageId;
    title?: string;
    description?: string;
    body?: string;
    sourceCardIds?: string[];
    changeSummary?: string;
  }>;
  conflicts?: Array<{ topic?: string; summary?: string; sourceCardIds?: string[] }>;
};

export type ProjectWikiSearchOutput = {
  needsProjectWiki?: boolean;
  intent?: string;
  selected?: Array<{ relativePath?: string; reason?: string; priority?: number }>;
  rejected?: Array<{ relativePath?: string; reason?: string }>;
  notes?: string;
};

export type ProjectWikiCurateOutput = {
  context?: string;
  sections?: Array<{ title?: string; content?: string; sourcePaths?: string[] }>;
  omitted?: Array<{ relativePath?: string; reason?: string }>;
  confidence?: number;
};

export const indexOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceType: { type: "string", enum: ["repo", "memory", "conversations", "knowledge"] },
          title: { type: "string" },
          description: { type: "string" },
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "stale", "conflict", "draft"] },
          statusReason: { type: "string" },
          importance: { type: "number" },
          evidenceLevel: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number" },
          qualitySignals: { type: "array", items: { type: "string" } },
          sourceRefs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string" },
                label: { type: "string" },
                path: { type: "string" },
                sessionId: { type: "string" },
                turnId: { type: "string" },
                messageId: { type: "string" },
                excerpt: { type: "string" },
                range: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    startLine: { type: "number" },
                    endLine: { type: "number" },
                    messageIndex: { type: "number" },
                  },
                },
                contentHash: { type: "string" },
              },
            },
          },
        },
        required: ["title", "summary"],
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string" },
          source: { type: "string" },
        },
      },
    },
  },
};

export const maintainOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pageId: {
            type: "string",
            enum: [
              "project-overview",
              "project-status",
              "project-feedback",
              "knowledge",
            ],
          },
          title: { type: "string" },
          description: { type: "string" },
          body: { type: "string" },
          sourceCardIds: { type: "array", items: { type: "string" } },
          changeSummary: { type: "string" },
        },
        required: ["pageId", "title", "description", "body"],
      },
    },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          summary: { type: "string" },
          sourceCardIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const searchOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    needsProjectWiki: { type: "boolean" },
    intent: { type: "string" },
    selected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relativePath: { type: "string" },
          reason: { type: "string" },
          priority: { type: "number" },
        },
      },
    },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relativePath: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

export const curateOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    context: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          sourcePaths: { type: "array", items: { type: "string" } },
        },
      },
    },
    omitted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relativePath: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    confidence: { type: "number" },
  },
};

export function isIndexOutput(value: unknown): value is ProjectWikiIndexOutput {
  if (!isRecord(value)) return false;
  if (value.cards !== undefined && !isArrayOf(value.cards, isIndexCard)) return false;
  if (value.skipped !== undefined && !isArrayOf(value.skipped, isSkippedItem)) return false;
  return true;
}

export function isMaintainOutput(value: unknown): value is ProjectWikiMaintainOutput {
  if (!isRecord(value)) return false;
  if (value.pages !== undefined && !isArrayOf(value.pages, isMaintainPage)) return false;
  if (value.conflicts !== undefined && !isArrayOf(value.conflicts, isConflictItem)) return false;
  return true;
}

export function isSearchOutput(value: unknown): value is ProjectWikiSearchOutput {
  if (!isRecord(value)) return false;
  if (value.needsProjectWiki !== undefined && typeof value.needsProjectWiki !== "boolean") return false;
  if (value.intent !== undefined && !isString(value.intent)) return false;
  if (value.notes !== undefined && !isString(value.notes)) return false;
  if (value.selected !== undefined && !isArrayOf(value.selected, isSearchSelectedItem)) return false;
  if (value.rejected !== undefined && !isArrayOf(value.rejected, isSearchRejectedItem)) return false;
  return true;
}

export function isCurateOutput(value: unknown): value is ProjectWikiCurateOutput {
  if (!isRecord(value)) return false;
  if (value.context !== undefined && !isString(value.context)) return false;
  if (value.sections !== undefined && !isArrayOf(value.sections, isCurateSection)) return false;
  if (value.omitted !== undefined && !isArrayOf(value.omitted, isOmittedItem)) return false;
  if (value.confidence !== undefined && !isNumber(value.confidence)) return false;
  const hasContext = typeof value.context === "string" && value.context.trim().length > 0;
  const hasSections = Array.isArray(value.sections) && value.sections.some((section) =>
    isRecord(section)
    && typeof section.title === "string"
    && section.title.trim().length > 0
    && typeof section.content === "string"
    && section.content.trim().length > 0);
  return hasContext || hasSections;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndexCard(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isString(value.title) || !isString(value.summary)) return false;
  if (value.sourceType !== undefined && !["repo", "memory", "conversations", "knowledge"].includes(String(value.sourceType))) {
    return false;
  }
  if (value.description !== undefined && !isString(value.description)) return false;
  if (value.tags !== undefined && !isStringArray(value.tags)) return false;
  if (value.status !== undefined && !["active", "stale", "conflict", "draft"].includes(String(value.status))) {
    return false;
  }
  if (value.statusReason !== undefined && !isString(value.statusReason)) return false;
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  if (value.evidenceLevel !== undefined && !["low", "medium", "high"].includes(String(value.evidenceLevel))) {
    return false;
  }
  if (value.confidence !== undefined && !isNumber(value.confidence)) return false;
  if (value.qualitySignals !== undefined && !isStringArray(value.qualitySignals)) return false;
  if (value.sourceRefs !== undefined && !isArrayOf(value.sourceRefs, isSourceRef)) return false;
  return true;
}

function isMaintainPage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["project-overview", "project-status", "project-feedback", "knowledge"].includes(String(value.pageId))
    && isString(value.title)
    && isString(value.description)
    && isString(value.body)
    && (value.sourceCardIds === undefined || isStringArray(value.sourceCardIds))
    && (value.changeSummary === undefined || isString(value.changeSummary));
}

function isConflictItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.topic === undefined || isString(value.topic))
    && (value.summary === undefined || isString(value.summary))
    && (value.sourceCardIds === undefined || isStringArray(value.sourceCardIds));
}

function isSearchSelectedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.relativePath === undefined || isProjectWikiCatalogMarkdownPath(value.relativePath))
    && (value.reason === undefined || isString(value.reason))
    && (value.priority === undefined || isNumber(value.priority));
}

function isSearchRejectedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.relativePath === undefined || isProjectWikiCatalogMarkdownPath(value.relativePath))
    && (value.reason === undefined || isString(value.reason));
}

function isCurateSection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.title === undefined || isString(value.title))
    && (value.content === undefined || isString(value.content))
    && (value.sourcePaths === undefined || isArrayOf(value.sourcePaths, isProjectWikiMarkdownPath));
}

function isOmittedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.relativePath === undefined || isProjectWikiMarkdownPath(value.relativePath))
    && (value.reason === undefined || isString(value.reason));
}

function isSkippedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.reason === undefined || isString(value.reason))
    && (value.source === undefined || isString(value.source));
}

function isSourceRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.kind === undefined || isString(value.kind))
    && (value.label === undefined || isString(value.label))
    && (value.path === undefined || isString(value.path))
    && (value.sessionId === undefined || isString(value.sessionId))
    && (value.turnId === undefined || isString(value.turnId))
    && (value.messageId === undefined || isString(value.messageId))
    && (value.excerpt === undefined || isString(value.excerpt))
    && (value.range === undefined || isSourceRange(value.range))
    && (value.contentHash === undefined || isString(value.contentHash));
}

function isSourceRange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.startLine === undefined || isNumber(value.startLine))
    && (value.endLine === undefined || isNumber(value.endLine))
    && (value.messageIndex === undefined || isNumber(value.messageIndex));
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isStringArray(value: unknown): boolean {
  return isArrayOf(value, isString);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProjectWikiMarkdownPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const path = value.replace(/\\/g, "/");
  return path.endsWith(".md")
    && !path.startsWith("/")
    && !path.startsWith("../")
    && !path.includes("/../")
    && (path.startsWith("wiki/") || path.startsWith("source_cards/"));
}

function isProjectWikiCatalogMarkdownPath(value: unknown): value is string {
  return value === "home.md" || isProjectWikiMarkdownPath(value);
}
