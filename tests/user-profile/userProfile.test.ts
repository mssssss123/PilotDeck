import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { DefaultContextRuntime } from "../../src/context/index.js";
import { ProjectWikiModelRunner } from "../../src/project-wiki/index.js";
import {
  UserProfileService,
  UserProfileStore,
} from "../../src/user-profile/index.js";

test("UserProfile is fixed context and updates through model extraction plus patch merge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-profile-"));
  const profileRoot = join(root, "user_profile");
  const projectRoot = join(root, "project");
  const transcriptPath = join(root, "transcript.jsonl");
  try {
    const modelRuntime = modelRuntimeForSchemas({
      user_profile_extract: {
        hasUserProfileSignal: true,
        candidates: [{
          category: "communication",
          content: "用户希望设计讨论时先结合源码判断，不要只是顺着用户说。",
          evidence: "用户要求先看源码，不要顺着编。",
          confidence: 0.92,
        }],
      },
      user_profile_merge: {
        operations: [{
          op: "add",
          category: "communication",
          content: "用户希望设计讨论时先结合源码判断，不要只是顺着用户说。",
          sourceCandidateIndexes: [0],
          confidence: 0.92,
          reason: "durable cross-project collaboration preference",
        }],
      },
    });
    const service = createService(profileRoot, modelRuntime);
    await service.captureTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      transcriptPath,
      errored: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "以后讨论设计，你要先结合源码判断，不要顺着我编。" }],
      }],
    });
    await service.flush();

    const profile = await readFile(join(profileRoot, "profile.md"), "utf8");
    assert.match(profile, /用户希望设计讨论时先结合源码判断/);
    const profileJson = JSON.parse(await readFile(join(profileRoot, "profile.json"), "utf8")) as {
      entries?: Array<{ content?: string; category?: string }>;
    };
    assert.equal(profileJson.entries?.length, 1);
    assert.equal(profileJson.entries?.[0]?.category, "communication");

    const runtime = new DefaultContextRuntime({
      userProfileResolver: service,
      projectRoot,
      transcriptPath,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });
    const prepared = await runtime.prepareForModel({
      sessionId: "session-1",
      turnId: "turn-2",
      cwd: projectRoot,
      provider: "test",
      model: "model",
      permissionMode: "default",
      additionalWorkingDirectories: [],
      messages: [{
        role: "user",
        content: [{ type: "text", text: "现在继续。" }],
      }],
      tools: [],
    });

    assert.match(prepared.systemPrompt ?? "", /<user-profile-context>/);
    assert.match(prepared.systemPrompt ?? "", /当前用户消息、系统设置和项目指令优先/);
    assert.match(prepared.systemPrompt ?? "", /不要只是顺着用户说/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserProfile merge replaces one entry without rewriting unrelated entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-profile-replace-"));
  const profileRoot = join(root, "user_profile");
  const projectRoot = join(root, "project");
  try {
    const store = new UserProfileStore({
      rootDir: profileRoot,
      language: "zh-CN",
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });
    await store.writeProfileDocument({
      version: 1,
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      entries: [
        {
          id: "entry-language",
          category: "communication",
          content: "用户默认偏好中文交流。",
          confidence: 0.8,
          status: "active",
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
        {
          id: "entry-workflow",
          category: "workflow",
          content: "用户偏好先讨论清楚再实现。",
          confidence: 0.9,
          status: "active",
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
      ],
    });

    const modelRuntime = modelRuntimeForSchemas({
      user_profile_extract: {
        hasUserProfileSignal: true,
        candidates: [{
          category: "communication",
          content: "用户通常偏好中文交流，但当前项目或系统设置可以覆盖语言。",
          evidence: "用户强调项目语言可能不同。",
          confidence: 0.9,
        }],
      },
      user_profile_merge: {
        operations: [{
          op: "replace",
          targetId: "entry-language",
          sourceCandidateIndexes: [0],
          confidence: 0.9,
        }],
      },
    });
    const service = createService(profileRoot, modelRuntime);
    await service.captureTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      errored: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "语言这件事要注意，项目设置可以覆盖我的默认偏好。" }],
      }],
    });
    await service.flush();

    const profileJson = JSON.parse(await readFile(join(profileRoot, "profile.json"), "utf8")) as {
      entries: Array<{ id: string; content: string }>;
    };
    assert.equal(profileJson.entries.length, 2);
    assert.match(profileJson.entries.find((entry) => entry.id === "entry-language")?.content ?? "", /系统设置可以覆盖语言/);
    assert.equal(
      profileJson.entries.find((entry) => entry.id === "entry-workflow")?.content,
      "用户偏好先讨论清楚再实现。",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserProfile imports legacy global profile outside ProjectWiki", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-profile-legacy-"));
  const profileRoot = join(root, "user_profile");
  const legacyMemoryRoot = join(root, "memory");
  try {
    await mkdir(join(legacyMemoryRoot, "global", "UserIdentity"), { recursive: true });
    await writeFile(join(legacyMemoryRoot, "global", "UserIdentity", "user-profile.md"), [
      "# User profile",
      "",
      "- 用户是 PilotDeck 的产品和工程决策者。",
    ].join("\n"), "utf8");

    const service = new UserProfileService({
      store: new UserProfileStore({
        rootDir: profileRoot,
        language: "zh-CN",
        now: () => new Date("2026-06-26T00:00:00.000Z"),
      }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          user_profile_extract: {
            hasUserProfileSignal: true,
            candidates: [{
              category: "identity",
              content: "用户是 PilotDeck 的产品和工程决策者。",
              evidence: "legacy global user profile",
              confidence: 0.86,
            }],
          },
          user_profile_merge: {
            operations: [{
              op: "add",
              category: "identity",
              content: "用户是 PilotDeck 的产品和工程决策者。",
              sourceCandidateIndexes: [0],
              confidence: 0.86,
            }],
          },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: {
        enabled: true,
        language: "zh-CN",
        maxContextChars: 3_000,
      },
      legacyMemoryRootDir: legacyMemoryRoot,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });

    await service.captureTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot: join(root, "project"),
      errored: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    });
    await service.flush();
    const context = await service.getContext({ sessionId: "session-1", turnId: "turn-1" });

    assert.match(context.systemContext ?? "", /用户是 PilotDeck 的产品和工程决策者/);
    const profile = await readFile(join(profileRoot, "profile.md"), "utf8");
    assert.match(profile, /用户是 PilotDeck 的产品和工程决策者/);
    await assert.rejects(
      () => readdir(join(root, "projects", "demo", "project_wiki")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserProfile passes explicit removal requests to maintainer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-profile-remove-"));
  const profileRoot = join(root, "user_profile");
  const projectRoot = join(root, "project");
  try {
    const store = new UserProfileStore({
      rootDir: profileRoot,
      language: "zh-CN",
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });
    await store.writeProfileDocument({
      version: 1,
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      entries: [{
        id: "entry-old-hobby",
        category: "identity",
        content: "兴趣：游戏开发",
        confidence: 0.8,
        status: "active",
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
      }],
    });
    let removalRequestsSeen = 0;
    const modelRuntime = modelRuntimeForSchemas({
      user_profile_extract: {
        hasUserProfileSignal: true,
        candidates: [{
          category: "identity",
          content: "爱好：摄影",
          evidence: "用户说爱好只保留摄影。",
          confidence: 0.95,
        }],
        removals: [{
          reason: "用户明确要求删除旧兴趣：游戏开发，特别是基于 Web 的 3D 游戏。",
        }],
      },
      user_profile_merge: (request: CanonicalModelRequest) => {
        const text = request.messages[0]?.content[0]?.type === "text"
          ? request.messages[0].content[0].text
          : "{}";
        const parsed = JSON.parse(text) as {
          removalRequests?: Array<{ targetDescription?: string }>;
        };
        removalRequestsSeen = parsed.removalRequests?.length ?? 0;
        assert.match(parsed.removalRequests?.[0]?.targetDescription ?? "", /游戏开发/);
        return {
          operations: [
            { op: "remove", targetId: "entry-old-hobby", reason: "matched explicit removal request" },
            {
              op: "add",
              category: "identity",
              content: "爱好：摄影",
              sourceCandidateIndexes: [0],
              confidence: 0.95,
            },
          ],
        };
      },
    });
    const service = createService(profileRoot, modelRuntime);
    await service.captureTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      errored: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "请删除旧兴趣游戏开发，我的爱好只保留摄影。" }],
      }],
    });
    await service.flush();

    assert.equal(removalRequestsSeen, 1);
    const profile = await readFile(join(profileRoot, "profile.md"), "utf8");
    assert.doesNotMatch(profile, /游戏开发/);
    assert.match(profile, /爱好：摄影/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createService(profileRoot: string, modelRuntime: ModelRuntime): UserProfileService {
  return new UserProfileService({
    store: new UserProfileStore({
      rootDir: profileRoot,
      language: "zh-CN",
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    }),
    modelRunner: new ProjectWikiModelRunner({
      modelRuntime,
      models: {},
      fallbackModel: { provider: "test", model: "model" },
      timeoutMs: 1_000,
    }),
    config: {
      enabled: true,
      language: "zh-CN",
      maxContextChars: 3_000,
    },
    now: () => new Date("2026-06-26T00:00:00.000Z"),
  });
}

function modelRuntimeForSchemas(
  outputs: Record<string, unknown | ((request: CanonicalModelRequest) => unknown | Promise<unknown>)>,
): ModelRuntime {
  return {
    async *stream() {
      throw new Error("stream should not be called");
    },
    async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      const schemaName = request.outputSchema?.name ?? "";
      const output = outputs[schemaName];
      if (output === undefined) {
        throw new Error(`Unexpected schema ${schemaName}`);
      }
      return jsonResponse(typeof output === "function" ? await output(request) : output);
    },
    getCapabilities() {
      return {} as ReturnType<ModelRuntime["getCapabilities"]>;
    },
    getMultimodal() {
      return {} as ReturnType<ModelRuntime["getMultimodal"]>;
    },
    getProviderBaseUrl() {
      return undefined;
    },
  };
}

function jsonResponse(value: unknown): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify(value),
    }],
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    raw: value,
  };
}
