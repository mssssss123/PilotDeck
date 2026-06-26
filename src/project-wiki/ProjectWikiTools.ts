import type { PilotDeckToolDefinition } from "../tool/index.js";
import { PilotDeckToolRuntimeError } from "../tool/index.js";
import type { ProjectWikiService } from "./ProjectWikiService.js";

export type ProjectWikiSearchToolInput = {
  query: string;
  limit?: number;
};

export type ProjectWikiReadToolInput = {
  relativePath: string;
  maxChars?: number;
};

export function createProjectWikiTools(service: ProjectWikiService): PilotDeckToolDefinition[] {
  return [
    createProjectWikiSearchTool(service),
    createProjectWikiReadTool(service),
  ];
}

function createProjectWikiSearchTool(
  service: ProjectWikiService,
): PilotDeckToolDefinition<ProjectWikiSearchToolInput> {
  return {
    name: "projectwiki_search",
    title: "Search ProjectWiki",
    description:
      "Search the current project's ProjectWiki using the configured ProjectWiki Searcher model. "
      + "Use this when the automatically injected ProjectWiki context is missing details or when you need traceable project knowledge. "
      + "Returns selected wiki/source-card paths with model reasons; follow up with projectwiki_read for full content.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "A focused natural-language query for the ProjectWiki Searcher model.",
        },
        limit: {
          type: "integer",
          description: "Optional maximum number of selected ProjectWiki materials to return.",
        },
      },
    },
    maxResultBytes: 80_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: async (input) => {
      if (!input.query || input.query.trim().length === 0) {
        return {
          ok: false,
          issues: [{ path: "query", code: "invalid_schema", message: "query is required." }],
        };
      }
      if (input.limit !== undefined && input.limit < 1) {
        return {
          ok: false,
          issues: [{ path: "limit", code: "invalid_schema", message: "limit must be greater than 0." }],
        };
      }
      return { ok: true, input };
    },
    execute: async (input, context) => {
      const result = await service.search({
        query: input.query,
        limit: input.limit,
        sessionId: context.sessionId,
        turnId: context.turnId,
        projectRoot: context.cwd,
        recentMessages: [],
        signal: context.abortSignal,
      });
      const text = formatProjectWikiSearchResult(result);
      return {
        content: [{ type: "text", text }],
        data: result,
      };
    },
  };
}

function createProjectWikiReadTool(
  service: ProjectWikiService,
): PilotDeckToolDefinition<ProjectWikiReadToolInput> {
  return {
    name: "projectwiki_read",
    title: "Read ProjectWiki",
    description:
      "Read a markdown file inside the current project's ProjectWiki by relative path. "
      + "Use paths returned by projectwiki_search, such as wiki/project-overview.md or source_cards/knowledge/...",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["relativePath"],
      additionalProperties: false,
      properties: {
        relativePath: {
          type: "string",
          description: "ProjectWiki-relative markdown path to read.",
        },
        maxChars: {
          type: "integer",
          description: "Optional character limit for returned content.",
        },
      },
    },
    maxResultBytes: 120_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: async (input) => {
      if (!input.relativePath || input.relativePath.trim().length === 0) {
        return {
          ok: false,
          issues: [{ path: "relativePath", code: "invalid_schema", message: "relativePath is required." }],
        };
      }
      if (!input.relativePath.endsWith(".md")) {
        return {
          ok: false,
          issues: [{ path: "relativePath", code: "invalid_schema", message: "relativePath must be a markdown path." }],
        };
      }
      if (input.maxChars !== undefined && input.maxChars < 1) {
        return {
          ok: false,
          issues: [{ path: "maxChars", code: "invalid_schema", message: "maxChars must be greater than 0." }],
        };
      }
      return { ok: true, input };
    },
    execute: async (input) => {
      const result = await service.read({
        relativePath: input.relativePath,
        maxChars: input.maxChars,
      });
      if (!result) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `ProjectWiki file not found: ${input.relativePath}`,
        );
      }
      return {
        content: [{ type: "text", text: result.content }],
        data: result,
      };
    },
  };
}

function formatProjectWikiSearchResult(result: Awaited<ReturnType<ProjectWikiService["search"]>>): string {
  const lines = [
    "# ProjectWiki Search Result",
    "",
  ];
  if (result.intent) lines.push(`Intent: ${result.intent}`, "");
  if (result.notes) lines.push(`Notes: ${result.notes}`, "");
  if (result.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.severity}: ${diagnostic.message}`);
    }
    lines.push("");
  }
  if (result.selected.length === 0) {
    lines.push("No ProjectWiki materials were selected.");
  } else {
    lines.push("Selected:");
    for (const item of result.selected) {
      lines.push(`- ${item.relativePath}${item.title ? ` (${item.title})` : ""}`);
      if (item.status && item.status !== "active") {
        lines.push(`  status: ${item.status}${item.statusReason ? ` - ${item.statusReason}` : ""}`);
      }
      if (item.sourceHealth && hasSourceHealthWarnings(item.sourceHealth)) {
        lines.push(`  source health: ${formatSourceHealth(item.sourceHealth)}`);
      }
      if (item.reason) lines.push(`  reason: ${item.reason}`);
      if (item.preview) lines.push(`  preview: ${item.preview.replace(/\s+/g, " ").slice(0, 320)}`);
    }
  }
  if (result.rejected.length > 0) {
    lines.push("", "Rejected:");
    for (const item of result.rejected.slice(0, 12)) {
      lines.push(`- ${item.relativePath}${item.reason ? `: ${item.reason}` : ""}`);
    }
  }
  return lines.join("\n").trim();
}

function hasSourceHealthWarnings(health: NonNullable<Awaited<ReturnType<ProjectWikiService["search"]>>["selected"][number]["sourceHealth"]>): boolean {
  return health.stale > 0 || health.conflict > 0 || health.missing > 0;
}

function formatSourceHealth(
  health: NonNullable<Awaited<ReturnType<ProjectWikiService["search"]>>["selected"][number]["sourceHealth"]>,
): string {
  const counts = [
    health.stale > 0 ? `${health.stale} stale` : "",
    health.conflict > 0 ? `${health.conflict} conflict` : "",
    health.missing > 0 ? `${health.missing} missing` : "",
  ].filter(Boolean).join(", ");
  const warning = health.warnings?.[0] ? ` (${health.warnings[0]})` : "";
  return `${counts || "ok"}${warning}`;
}
