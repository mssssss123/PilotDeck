import type { CanonicalMessage } from "../model/index.js";
import type {
  ProjectWikiDiagnostic,
  ProjectWikiResolver,
  ProjectWikiRetrieveInput,
} from "./types.js";

export type ProjectWikiAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: ProjectWikiDiagnostic[];
};

export type ProjectWikiAttachmentBuilderInput = ProjectWikiRetrieveInput & {
  timeoutMs?: number;
};

export class ProjectWikiAttachmentBuilder {
  constructor(private readonly resolver: ProjectWikiResolver) {}

  async build(input: ProjectWikiAttachmentBuilderInput): Promise<ProjectWikiAttachmentBuilderResult> {
    if (input.signal?.aborted) {
      return { attachments: [], diagnostics: [] };
    }
    const controller = new AbortController();
    const detachAbort = forwardAbort(input.signal, controller);
    const timeoutMs = input.timeoutMs;
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`ProjectWiki retrieval timed out after ${timeoutMs}ms.`)), timeoutMs)
      : undefined;
    try {
      const result = await Promise.race([
        this.resolver.retrieve({ ...input, signal: controller.signal }),
        waitForAbort(controller.signal),
      ]);
      if (!result.systemContext || result.systemContext.trim().length === 0) {
        return { attachments: [], diagnostics: result.diagnostics ?? [] };
      }
      const attachments: CanonicalMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<project-wiki-context>\n${result.systemContext.trim()}\n</project-wiki-context>`,
            },
          ],
        },
      ];
      return { attachments, diagnostics: result.diagnostics ?? [] };
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted) {
          return { attachments: [], diagnostics: [] };
        }
        return {
          attachments: [],
          diagnostics: [{
            code: "project_wiki_model_error",
            severity: "warning",
            message: timeoutMs && timeoutMs > 0
              ? `ProjectWiki.retrieve timed out after ${timeoutMs}ms.`
              : "ProjectWiki.retrieve was aborted.",
          }],
        };
      }
      return {
        attachments: [],
        diagnostics: [{
          code: "project_wiki_model_error",
          severity: "warning",
          message: `ProjectWiki.retrieve failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    } finally {
      if (timer) clearTimeout(timer);
      detachAbort?.();
    }
  }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throwAbortError(signal.reason);
  }
  return await new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwAbortError(reason?: unknown): never {
  throw createAbortError(reason);
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new Error(message);
}
