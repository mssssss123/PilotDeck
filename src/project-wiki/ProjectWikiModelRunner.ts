import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalToolSchema,
  ModelRuntime,
} from "../model/index.js";
import { extractStructuredOutput } from "../model/structuredOutput/extractStructuredOutput.js";
import type { ProjectWikiModelRef, ProjectWikiModelRole } from "./types.js";

export type ProjectWikiModelRunnerOptions = {
  modelRuntime: ModelRuntime;
  models: Partial<Record<ProjectWikiModelRole, ProjectWikiModelRef>>;
  fallbackModel: ProjectWikiModelRef;
  timeoutMs: number;
};

export type ProjectWikiStructuredCallInput = {
  role: ProjectWikiModelRole;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  validate?: (value: unknown) => boolean;
};

export type ProjectWikiStructuredCallResult<T> = {
  value: T;
  response: CanonicalModelResponse;
  model: ProjectWikiModelRef;
};

export type ProjectWikiCompleteCallInput = {
  role: ProjectWikiModelRole;
  systemPrompt: string;
  messages: CanonicalMessage[];
  tools?: CanonicalToolSchema[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type ProjectWikiCompleteCallResult = {
  response: CanonicalModelResponse;
  model: ProjectWikiModelRef;
};

export class ProjectWikiModelRunner {
  constructor(private readonly options: ProjectWikiModelRunnerOptions) {}

  resolveModel(role: ProjectWikiModelRole): ProjectWikiModelRef {
    return this.options.models[role] ?? this.options.fallbackModel;
  }

  async structured<T>(input: ProjectWikiStructuredCallInput): Promise<ProjectWikiStructuredCallResult<T>> {
    const model = this.resolveModel(input.role);
    const request: CanonicalModelRequest = {
      provider: model.provider,
      model: model.model,
      systemPrompt: input.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: input.userPrompt }],
        },
      ],
      maxOutputTokens: input.maxOutputTokens ?? 4096,
      temperature: 0,
      thinking: { enabled: false },
      stream: false,
      outputSchema: {
        name: input.schemaName,
        description: "Structured ProjectWiki model decision.",
        schema: input.schema,
        strict: false,
      },
    };

    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const detach = forwardAbort(input.signal, controller);
    try {
      const timeoutMs = Math.max(500, this.options.timeoutMs);
      const response = await Promise.race([
        this.options.modelRuntime.complete(request, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`ProjectWiki ${input.role} model timed out after ${timeoutMs}ms.`);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      const extracted = extractStructuredOutput(response, { validate: input.validate });
      if (!extracted.ok) {
        throw new Error(`ProjectWiki ${input.role} structured output failed: ${extracted.reason}`);
      }
      return { value: extracted.value as T, response, model };
    } finally {
      if (timer) clearTimeout(timer);
      detach?.();
    }
  }

  async complete(input: ProjectWikiCompleteCallInput): Promise<ProjectWikiCompleteCallResult> {
    const model = this.resolveModel(input.role);
    const request: CanonicalModelRequest = {
      provider: model.provider,
      model: model.model,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.tools && input.tools.length > 0 ? "auto" : undefined,
      maxOutputTokens: input.maxOutputTokens ?? 4096,
      temperature: 0,
      thinking: { enabled: false },
      stream: false,
    };

    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const detach = forwardAbort(input.signal, controller);
    try {
      const timeoutMs = Math.max(500, this.options.timeoutMs);
      const response = await Promise.race([
        this.options.modelRuntime.complete(request, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`ProjectWiki ${input.role} model timed out after ${timeoutMs}ms.`);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      return { response, model };
    } finally {
      if (timer) clearTimeout(timer);
      detach?.();
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
