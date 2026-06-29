import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { DefaultContextRuntime } from "../../src/context/index.js";
import type { PilotConfigDiagnostic } from "../../src/pilot/config/types.js";
import { parseProjectWikiConfig } from "../../src/pilot/config/parseProjectWikiConfig.js";
import { resolveProjectStorageId } from "../../src/pilot/paths.js";
import { isCurateOutput, isSearchOutput } from "../../src/project-wiki/schemas.js";
import {
  ProjectWikiModelRunner,
  ProjectWikiService,
  ProjectWikiStore,
  createProjectWikiServiceFromConfig,
  createProjectWikiTools,
  type ProjectWikiResolver,
} from "../../src/project-wiki/index.js";

test("ProjectWiki config defaults enable the unified wiki layer", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseProjectWikiConfig(undefined, diagnostics, "/tmp/project_wiki");

  assert.deepEqual(diagnostics, []);
  assert.equal(config?.enabled, true);
  assert.equal(config?.language, "en");
  assert.equal(config?.rootDir, "/tmp/project_wiki");
  assert.deepEqual(config?.models, {});
  assert.deepEqual(config?.sources, {
    repo: true,
    memory: true,
    conversations: true,
    knowledge: true,
  });
  assert.equal(config?.limits.maxContextChars, 12_000);
  assert.equal(config?.limits.modelTimeoutMs, 60_000);
});

test("ProjectWiki config preserves model roles, source toggles, and limits", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseProjectWikiConfig({
    enabled: true,
    language: "zh-CN",
    rootDir: "/custom/wiki",
    models: {
      indexer: "edgeclaw/index",
      maintainer: "edgeclaw/maintain",
      searcher: "edgeclaw/search",
      curator: "edgeclaw/curate",
    },
    sources: {
      repo: false,
      memory: false,
      conversations: true,
      knowledge: true,
    },
    limits: {
      maxContextChars: 20_000,
      maxSourceCardsPerTurn: 5,
      maxCatalogChars: 30_000,
      maxMaterialChars: 4_000,
      modelTimeoutMs: 9_000,
    },
  }, diagnostics, "/tmp/project_wiki");

  assert.deepEqual(diagnostics, []);
  assert.equal(config?.language, "zh-CN");
  assert.equal(config?.rootDir, "/custom/wiki");
  assert.deepEqual(config?.models, {
    indexer: "edgeclaw/index",
    maintainer: "edgeclaw/maintain",
    searcher: "edgeclaw/search",
    curator: "edgeclaw/curate",
  });
  assert.deepEqual(config?.sources, {
    repo: false,
    memory: false,
    conversations: true,
    knowledge: true,
  });
  assert.deepEqual(config?.limits, {
    maxContextChars: 20_000,
    maxSourceCardsPerTurn: 5,
    maxCatalogChars: 30_000,
    maxMaterialChars: 4_000,
    modelTimeoutMs: 9_000,
  });
});

test("ProjectWiki structured validators reject malformed retrieval and curator payloads", () => {
  assert.equal(isSearchOutput({
    needsProjectWiki: true,
    selected: [{ relativePath: "wiki/knowledge.md", reason: "Relevant page.", priority: 10 }],
    rejected: [],
  }), true);
  assert.equal(isSearchOutput({
    selected: [{ relativePath: "home.md", reason: "Navigation should not be injected." }],
  }), true);
  assert.equal(isSearchOutput({
    selected: [{ relativePath: "../outside.md", reason: "Escapes the wiki root." }],
  }), false);

  assert.equal(isCurateOutput({}), false);
  assert.equal(isCurateOutput({
    sections: [{
      title: "Reusable Knowledge",
      content: "ProjectWiki context must remain source-backed.",
      sourcePaths: ["source_cards/knowledge/example.md"],
    }],
  }), true);
  assert.equal(isCurateOutput({
    sections: [{
      title: "Unsafe",
      content: "This points outside ProjectWiki.",
      sourcePaths: ["../secret.md"],
    }],
  }), false);
});

test("DefaultContextRuntime caches ProjectWiki context within one agent turn", async () => {
  let retrieveCalls = 0;
  let captureCalls = 0;
  const resolver: ProjectWikiResolver = {
    async retrieve(input) {
      retrieveCalls += 1;
      return {
        systemContext: `call ${retrieveCalls}: ${input.query}`,
        diagnostics: [],
      };
    },
    async captureTurn() {
      captureCalls += 1;
    },
  };
  const runtime = new DefaultContextRuntime({
    projectWikiResolver: resolver,
    projectRoot: "/tmp/project",
    now: () => new Date("2026-06-25T00:00:00.000Z"),
  });
  const messages: CanonicalMessage[] = [{
    role: "user",
    content: [{ type: "text", text: "How should ProjectWiki retrieve context?" }],
  }];
  const prepare = (turnId: string) => runtime.prepareForModel({
    sessionId: "session-cache",
    turnId,
    cwd: "/tmp/project",
    provider: "test",
    model: "model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages,
    tools: [],
  });

  const first = await prepare("turn-1");
  const second = await prepare("turn-1");

  assert.equal(retrieveCalls, 1);
  assert.match(first.systemPrompt ?? "", /call 1: How should ProjectWiki retrieve context\?/);
  assert.equal(second.systemPrompt, first.systemPrompt);

  await prepare("turn-2");
  assert.equal(retrieveCalls, 2);

  await runtime.captureTurn({
    sessionId: "session-cache",
    turnId: "turn-2",
    messages,
    errored: false,
  });
  assert.equal(captureCalls, 1);

  await prepare("turn-2");
  assert.equal(retrieveCalls, 3);
});

test("ProjectWiki source cards keep fallback transcript paths when model refs omit them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const transcriptPath = join(root, "transcript.jsonl");

  try {
    const modelRuntime = createSourceRefModelRuntime();
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime,
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: {
        enabled: true,
        language: "en",
        models: {},
        sources: {
          repo: false,
          memory: false,
          conversations: true,
          knowledge: true,
        },
        limits: {
          maxContextChars: 12_000,
          maxSourceCardsPerTurn: 12,
          maxCatalogChars: 24_000,
          maxMaterialChars: 8_000,
          modelTimeoutMs: 1_000,
        },
      },
    });

    await service.captureTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      transcriptPath,
      errored: false,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Remember this project fact." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The durable fact is now known." }],
        },
      ],
    });
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "conversations"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "conversations", cards[0]!), "utf8");
    assert.match(card, new RegExp(`"path":"${escapeRegExp(transcriptPath)}"`));
    assert.match(card, new RegExp(`path=${escapeRegExp(transcriptPath)}`));
    assert.match(card, /messageId":"Message 2"/);
    assert.match(card, /excerpt":"durable fact"/);
    assert.match(card, /range=message:2/);
    assert.match(card, /contentHash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki source cards keep persisted tool result and media source refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-tool-refs-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const toolResultPath = join(root, "tool-results", "tool-result.json");
  const mediaPath = join(root, "tool-results", "plot.png");

  try {
    await mkdir(join(root, "tool-results"), { recursive: true });
    await writeFile(toolResultPath, JSON.stringify({ rows: [{ id: 1, status: "ready" }] }), "utf8");
    await writeFile(mediaPath, "fake image bytes", "utf8");
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Persisted Tool Evidence",
              description: "Knowledge extracted from a persisted tool result.",
              summary: "The project data export showed one ready row and a generated plot.",
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: true, knowledge: true }),
    });

    await service.captureTurn({
      sessionId: "session-tool-refs",
      turnId: "turn-tool-refs",
      projectRoot,
      transcriptPath: join(root, "transcript.jsonl"),
      errored: false,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Summarize the persisted export." }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result_reference",
              toolCallId: "tool-call-1",
              path: toolResultPath,
              originalBytes: 4096,
              preview: "rows: [{ id: 1, status: ready }]",
              hasMore: true,
              mimeType: "application/json",
            },
            {
              type: "media_reference",
              toolCallId: "tool-call-2",
              path: mediaPath,
              originalBytes: 1024,
              preview: "[image omitted from memory: image/png, 1024 bytes]",
              hasMore: true,
              mimeType: "image/png",
              mediaType: "image",
            },
          ],
        },
      ],
    });
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "knowledge", cards[0]!), "utf8");
    assert.match(card, /tool_result_reference/);
    assert.match(card, /media_reference/);
    assert.match(card, new RegExp(`"path":"${escapeRegExp(toolResultPath)}"`));
    assert.match(card, new RegExp(`"path":"${escapeRegExp(mediaPath)}"`));
    assert.match(card, new RegExp(`path=${escapeRegExp(toolResultPath)}`));
    assert.match(card, /messageId":"Message 2"/);
    assert.match(card, /excerpt":"rows: \[\{ id: 1, status: ready \}\]"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki reuses duplicate source cards and merges new source refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dedupe-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    const turn1Transcript = await writeTranscriptForCapture(root, projectRoot, "turn-1");
    const turn2Transcript = await writeTranscriptForCapture(root, projectRoot, "turn-2");
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Project Testing Stack",
              description: "Reusable knowledge about the testing stack.",
              summary: "The project uses Jest and Supertest for API tests.",
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: true, knowledge: true }),
    });

    await service.captureTurn({
      ...captureInput(projectRoot, "turn-1"),
      transcriptPath: turn1Transcript,
    });
    await service.captureTurn({
      ...captureInput(projectRoot, "turn-2"),
      transcriptPath: turn2Transcript,
    });
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "knowledge", cards[0]!), "utf8");
    assert.match(card, /turn-1/);
    assert.match(card, /turn-2/);
    assert.match(card, new RegExp(`path=${escapeRegExp(join(root, "turn-1.jsonl"))}`));
    assert.match(card, new RegExp(`path=${escapeRegExp(join(root, "turn-2.jsonl"))}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki promotes reusable draft knowledge when stronger evidence arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-draft-promote-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let indexCalls = 0;

  try {
    const draftTranscript = await writeTranscriptForCapture(root, projectRoot, "turn-draft");
    const confirmedTranscript = await writeTranscriptForCapture(root, projectRoot, "turn-confirmed");
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: () => {
            indexCalls += 1;
            return {
              cards: [{
                sourceType: "knowledge",
                title: "Project Testing Stack",
                description: "Reusable knowledge about the testing stack.",
                summary: "The project uses Jest and Supertest for API tests.",
                confidence: indexCalls === 1 ? 0.42 : 0.95,
                evidenceLevel: indexCalls === 1 ? "low" : "high",
                qualitySignals: [indexCalls === 1 ? "assistant_generated" : "user_confirmed"],
              }],
            };
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn({
      ...captureInput(projectRoot, "turn-draft"),
      transcriptPath: draftTranscript,
    });
    await service.captureTurn({
      ...captureInput(projectRoot, "turn-confirmed"),
      transcriptPath: confirmedTranscript,
    });
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "knowledge", cards[0]!), "utf8");
    assert.match(card, /status: "active"/);
    assert.match(card, /statusReason: ""/);
    assert.match(card, /evidenceLevel: "high"/);
    assert.match(card, /confidence: 0\.95/);
    assert.match(card, /assistant_generated/);
    assert.match(card, /user_confirmed/);
    assert.match(card, /turn-draft/);
    assert.match(card, /turn-confirmed/);
    assert.doesNotMatch(card, /below the active threshold/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki does not reuse stale source cards for fresh duplicate evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-stale-reuse-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });

  try {
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Project Testing Stack",
              description: "Reusable knowledge about the testing stack.",
              summary: "The project uses Jest and Supertest for API tests.",
              confidence: 0.92,
              evidenceLevel: "high",
              qualitySignals: ["tool_verified"],
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn({
      ...captureInput(projectRoot, "turn-stale"),
      transcriptPath: join(root, "turn-stale.jsonl"),
    });
    await service.flushMaintenance();
    const staleCards = await store.markSourceCardsStale("knowledge", "Original transcript is missing.");
    assert.equal(staleCards.length, 1);

    await service.captureTurn({
      ...captureInput(projectRoot, "turn-fresh"),
      transcriptPath: join(root, "turn-fresh.jsonl"),
    });
    await service.flushMaintenance();

    const cards = (await readdir(join(wikiRoot, "source_cards", "knowledge"))).sort();
    assert.equal(cards.length, 2);
    const texts = await Promise.all(cards.map((card) => readFile(join(wikiRoot, "source_cards", "knowledge", card), "utf8")));
    assert.equal(texts.filter((text) => /status: "stale"/.test(text)).length, 1);
    assert.equal(texts.filter((text) => /status: "active"/.test(text)).length, 1);
    const active = texts.find((text) => /status: "active"/.test(text)) ?? "";
    assert.match(active, /turn-fresh/);
    assert.doesNotMatch(active, /Original transcript is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki stores low-confidence knowledge as draft with quality metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-low-confidence-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Tentative Agent Advice",
              description: "A potentially reusable assistant suggestion without enough evidence.",
              summary: "The assistant suggested a future architecture direction, but no user or tool evidence confirmed it.",
              confidence: 0.42,
              evidenceLevel: "low",
              qualitySignals: ["assistant_generated"],
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-low-confidence"));
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "knowledge", cards[0]!), "utf8");
    assert.match(card, /status: "draft"/);
    assert.match(card, /Knowledge confidence 0\.42 is below the active threshold/);
    assert.match(card, /confidence: 0\.42/);
    assert.match(card, /evidenceLevel: "low"/);
    assert.match(card, /qualitySignals:\n  - "assistant_generated"/);
    assert.match(card, /## Quality/);
    assert.match(card, /- signal: assistant_generated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki preserves high-quality knowledge metadata in markdown and catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-high-confidence-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Validated ProjectWiki Direction",
              description: "Reusable ProjectWiki design knowledge confirmed by the user.",
              summary: "ProjectWiki should own memory retrieval and provide traceable project context before the main agent runs.",
              confidence: 0.93,
              evidenceLevel: "high",
              qualitySignals: ["user_confirmed", "reusable_design_decision"],
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-high-confidence"));
    await service.flushMaintenance();

    const cards = await readdir(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
    const relativePath = `source_cards/knowledge/${cards[0]!}`;
    const card = await readFile(join(wikiRoot, relativePath), "utf8");
    assert.match(card, /status: "active"/);
    assert.match(card, /confidence: 0\.93/);
    assert.match(card, /evidenceLevel: "high"/);
    assert.match(card, /- signal: user_confirmed/);

    const catalog = await store.listCatalog(24_000);
    const entry = catalog.find((item) => item.relativePath === relativePath);
    assert.equal(entry?.confidence, 0.93);
    assert.equal(entry?.evidenceLevel, "high");
    assert.deepEqual(entry?.qualitySignals, ["user_confirmed", "reusable_design_decision"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki retrieval uses model search and curator to assemble traceable context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-retrieve-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const sourceCard = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "TaskFlow Test Stack",
      description: "Known testing stack for TaskFlow.",
      summary: "TaskFlow uses Jest with Supertest for HTTP API coverage.",
      sourceRefs: [{
        kind: "transcript",
        label: "fixture",
        path: join(root, "conversation.jsonl"),
        range: { startLine: 2, endLine: 4 },
        contentHash: "stack-hash",
      }],
    });
    await store.writeWikiPage({
      pageId: "knowledge",
      title: "Knowledge",
      description: "Reusable project knowledge.",
      body: "## Testing\nTaskFlow uses Jest with Supertest.",
      sourceCardIds: [sourceCard.id],
      changeSummary: "Seeded test knowledge.",
    });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_search: (request: CanonicalModelRequest) => {
            assert.match(request.systemPrompt ?? "", /Simplified Chinese \(zh-CN\)/);
            const first = request.messages[0]?.content[0];
            const prompt = first?.type === "text" ? first.text : "{}";
            const parsed = JSON.parse(prompt) as { outputLanguage?: string; outputLanguageName?: string };
            assert.equal(parsed.outputLanguage, "zh-CN");
            assert.equal(parsed.outputLanguageName, "Simplified Chinese (zh-CN)");
            return {
              needsProjectWiki: true,
              intent: "Find the testing stack.",
              selected: [
                { relativePath: "home.md", reason: "Navigation entry should not become context.", priority: 99 },
                { relativePath: "wiki/knowledge.md", reason: "Canonical testing stack page.", priority: 10 },
                { relativePath: sourceCard.relativePath, reason: "Traceable source card.", priority: 9 },
              ],
              rejected: [],
            };
          },
          project_wiki_curate: (request: CanonicalModelRequest) => {
            assert.match(request.systemPrompt ?? "", /Simplified Chinese \(zh-CN\)/);
            const first = request.messages[0]?.content[0];
            const prompt = first?.type === "text" ? first.text : "{}";
            const parsed = JSON.parse(prompt) as { outputLanguage?: string; outputLanguageName?: string };
            assert.equal(parsed.outputLanguage, "zh-CN");
            assert.equal(parsed.outputLanguageName, "Simplified Chinese (zh-CN)");
            return {
              sections: [{
                title: "Testing Stack",
                content: "TaskFlow uses Jest with Supertest for API coverage.",
                sourcePaths: ["wiki/knowledge.md", sourceCard.relativePath],
              }],
            };
          },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: {
        ...projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
        language: "zh-CN",
      },
    });

    const result = await service.retrieve({
      query: "What is the test stack?",
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      recentMessages: [{
        role: "user",
        content: [{ type: "text", text: "What is the test stack?" }],
      }],
    });

    assert.equal(result.diagnostics.length, 0);
    assert.match(result.systemContext ?? "", /Testing Stack/);
    assert.match(result.systemContext ?? "", /<entry type="wiki_page" path="wiki\/knowledge\.md">/);
    assert.match(result.systemContext ?? "", /<sourceRefs>/);
    assert.match(result.systemContext ?? "", new RegExp(escapeRegExp(sourceCard.relativePath)));
    const retrievalTraces = await store.readTrace("retrieval");
    const contextTraces = await store.readTrace("context");
    const retrievalTrace = retrievalTraces.find((trace) => trace.phase === "search");
    const toolLoopFallbackTrace = retrievalTraces.find((trace) => trace.phase === "tool_loop_fallback");
    const readTrace = retrievalTraces.find((trace) => trace.phase === "read");
    const contextTrace = contextTraces[0];
    assert.ok(retrievalTrace);
    assert.ok(toolLoopFallbackTrace);
    assert.ok(readTrace);
    assert.ok(contextTrace);
    assert.equal(retrievalTrace.language, "zh-CN");
    assert.equal(toolLoopFallbackTrace.language, "zh-CN");
    assert.equal(readTrace.language, "zh-CN");
    assert.equal(contextTrace.language, "zh-CN");
    assert.equal(toolLoopFallbackTrace.status, "skipped");
    assert.match(JSON.stringify(toolLoopFallbackTrace.output), /structured search/);
    assert.equal(retrievalTrace.phase, "search");
    assert.equal(readTrace.phase, "read");
    assert.equal(contextTrace.phase, "assemble");
    assert.equal(retrievalTrace.pipelineKind, "retrieval_context");
    assert.equal(readTrace.pipelineKind, "retrieval_context");
    assert.equal(contextTrace.pipelineKind, "retrieval_context");
    assert.equal(retrievalTrace.pipelineRunId, readTrace.pipelineRunId);
    assert.equal(retrievalTrace.pipelineRunId, contextTrace.pipelineRunId);
    assert.equal(retrievalTrace.stepIndex, 2);
    assert.equal(readTrace.stepIndex, 3);
    assert.equal(contextTrace.stepIndex, 4);
    assert.equal(retrievalTrace.stepName, "retrieval_decision");
    assert.equal(contextTrace.stepName, "assemble_context");
    assert.equal(readTrace.status, "success");
    assert.equal(readTrace.artifacts?.length, 2);
    assert.deepEqual(
      (readTrace.output as { missingPaths?: string[] }).missingPaths,
      [],
    );
    assert.match(
      JSON.stringify(readTrace.output),
      new RegExp(escapeRegExp(sourceCard.relativePath)),
    );
    assert.equal(contextTrace.artifacts?.[0]?.kind, "context");
    const rawSearchInputPath = retrievalTrace.payloadRefs?.input;
    const rawSearchOutputPath = retrievalTrace.payloadRefs?.output;
    const modelSearchRequestPath = retrievalTrace.payloadRefs?.modelRequest;
    const modelSearchResponsePath = retrievalTrace.payloadRefs?.modelResponse;
    const parsedSearchOutputPath = retrievalTrace.payloadRefs?.parsedOutput;
    const rawReadInputPath = readTrace.payloadRefs?.input;
    const rawReadOutputPath = readTrace.payloadRefs?.output;
    const rawCuratorInputPath = contextTrace.payloadRefs?.input;
    const rawCuratorOutputPath = contextTrace.payloadRefs?.output;
    const modelCuratorRequestPath = contextTrace.payloadRefs?.modelRequest;
    const modelCuratorResponsePath = contextTrace.payloadRefs?.modelResponse;
    assert.ok(rawSearchInputPath);
    assert.ok(rawSearchOutputPath);
    assert.ok(modelSearchRequestPath);
    assert.ok(modelSearchResponsePath);
    assert.ok(parsedSearchOutputPath);
    assert.ok(rawReadInputPath);
    assert.ok(rawReadOutputPath);
    assert.ok(rawCuratorInputPath);
    assert.ok(rawCuratorOutputPath);
    assert.ok(modelCuratorRequestPath);
    assert.ok(modelCuratorResponsePath);
    const rawSearchInput = await readFile(join(wikiRoot, rawSearchInputPath), "utf8");
    const rawSearchOutput = await readFile(join(wikiRoot, rawSearchOutputPath), "utf8");
    const modelSearchRequest = await readFile(join(wikiRoot, modelSearchRequestPath), "utf8");
    const modelSearchResponse = await readFile(join(wikiRoot, modelSearchResponsePath), "utf8");
    const parsedSearchOutput = await readFile(join(wikiRoot, parsedSearchOutputPath), "utf8");
    const rawReadInput = await readFile(join(wikiRoot, rawReadInputPath), "utf8");
    const rawReadOutput = await readFile(join(wikiRoot, rawReadOutputPath), "utf8");
    const rawCuratorInput = await readFile(join(wikiRoot, rawCuratorInputPath), "utf8");
    const rawCuratorOutput = await readFile(join(wikiRoot, rawCuratorOutputPath), "utf8");
    const modelCuratorRequest = await readFile(join(wikiRoot, modelCuratorRequestPath), "utf8");
    const modelCuratorResponse = await readFile(join(wikiRoot, modelCuratorResponsePath), "utf8");
    assert.match(rawSearchInput, /What is the test stack/);
    assert.doesNotMatch(rawSearchInput, /home\.md/);
    assert.match(rawSearchOutput, /Canonical testing stack page/);
    assert.match(rawSearchOutput, /home\.md/);
    assert.match(modelSearchRequest, /You are ProjectWiki Searcher inside PilotDeck/);
    assert.match(modelSearchRequest, /project_wiki_search/);
    assert.match(modelSearchResponse, /Canonical testing stack page/);
    assert.match(parsedSearchOutput, /Find the testing stack/);
    assert.match(rawReadInput, /wiki\/knowledge\.md/);
    assert.doesNotMatch(rawReadInput, /home\.md/);
    assert.match(rawReadOutput, /TaskFlow uses Jest with Supertest/);
    assert.match(rawCuratorInput, new RegExp(escapeRegExp(sourceCard.relativePath)));
    assert.doesNotMatch(rawCuratorInput, /home\.md/);
    assert.match(rawCuratorOutput, /TaskFlow uses Jest with Supertest/);
    assert.match(modelCuratorRequest, /You are ProjectWiki Curator inside PilotDeck/);
    assert.match(modelCuratorResponse, /TaskFlow uses Jest with Supertest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki retrieval can use an internal tool loop before curator assembly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-tool-loop-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const toolLoopCalls: string[] = [];

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const sourceCard = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "TaskFlow Test Stack",
      description: "Known testing stack for TaskFlow.",
      summary: "TaskFlow uses Jest with Supertest for HTTP API coverage.",
      sourceRefs: [{ kind: "transcript", label: "fixture", contentHash: "tool-loop-stack" }],
    });
    await store.appendConflicts([{
      topic: "Test stack conflict",
      summary: "The test runner evidence needs review before treating the stack as settled.",
      sourceCardIds: [sourceCard.id],
    }]);
    await store.writeWikiPage({
      pageId: "knowledge",
      title: "Knowledge",
      description: "Reusable project knowledge.",
      body: "## Testing\nTaskFlow uses Jest with Supertest.",
      sourceCardIds: [sourceCard.id],
      changeSummary: "Seeded test knowledge.",
    });

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            if (request.outputSchema?.name === "project_wiki_curate") {
              return jsonResponse({
                sections: [{
                  title: "Testing Stack",
                  content: "TaskFlow uses Jest with Supertest for API coverage.",
                  sourcePaths: ["wiki/knowledge.md", sourceCard.relativePath],
                }],
              });
            }
            if (request.outputSchema?.name === "project_wiki_tool_catalog_search") {
              const inputText = request.messages[0]?.content[0]?.type === "text"
                ? request.messages[0].content[0].text
                : "";
              const toolSearchInput = JSON.parse(inputText) as {
                query?: string;
                catalog?: Array<{ relativePath: string; title?: string }>;
                toolRequest?: string;
              };
              assert.equal(toolSearchInput.query, "testing stack");
              assert.equal(toolSearchInput.toolRequest, "projectwiki_search");
              assert.ok(toolSearchInput.catalog?.some((entry) => entry.relativePath === sourceCard.relativePath));
              return jsonResponse({
                needsProjectWiki: true,
                intent: "Narrow candidates for the retriever tool loop.",
                selected: [
                  { relativePath: sourceCard.relativePath, reason: "Searcher model selected the source card.", priority: 10 },
                ],
                rejected: [],
              });
            }
            assert.ok(request.tools?.some((tool) => tool.name === "projectwiki_search"));
            const step = toolLoopCalls.length;
            if (step === 0) {
              const inputText = request.messages[0]?.content[0]?.type === "text"
                ? request.messages[0].content[0].text
                : "";
              const retrieverInput = JSON.parse(inputText) as {
                openConflicts?: Array<{ topic: string; sourceCardIds: string[]; sourcePaths: string[] }>;
              };
              assert.equal(retrieverInput.openConflicts?.[0]?.topic, "Test stack conflict");
              assert.deepEqual(retrieverInput.openConflicts?.[0]?.sourceCardIds, [sourceCard.id]);
              assert.deepEqual(retrieverInput.openConflicts?.[0]?.sourcePaths, [sourceCard.relativePath]);
              toolLoopCalls.push("search");
              return toolCallResponse("projectwiki_search", { query: "testing stack", limit: 4 }, "tc-search");
            }
            if (step === 1) {
              const toolResultText = JSON.stringify(request.messages);
              assert.match(toolResultText, /TaskFlow Test Stack/);
              toolLoopCalls.push("read");
              return toolCallResponse("projectwiki_read", {
                relativePath: sourceCard.relativePath,
                maxChars: 2_000,
              }, "tc-read");
            }
            toolLoopCalls.push("finish");
            return toolCallResponse("projectwiki_finish", {
              needsProjectWiki: true,
              intent: "Find the testing stack.",
              selected: [
                { relativePath: "wiki/knowledge.md", reason: "Canonical wiki page.", priority: 10 },
                { relativePath: sourceCard.relativePath, reason: "Read by retriever tool loop.", priority: 9 },
              ],
              rejected: [],
              notes: "Used ProjectWiki search/read tools before selecting materials.",
            }, "tc-finish");
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "tool-loop-model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    const result = await service.retrieve({
      query: "What is the test stack?",
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      recentMessages: [{
        role: "user",
        content: [{ type: "text", text: "What is the test stack?" }],
      }],
    });

    assert.deepEqual(toolLoopCalls, ["search", "read", "finish"]);
    assert.equal(result.diagnostics.length, 0);
    assert.match(result.systemContext ?? "", /Testing Stack/);
    const retrievalTraces = await store.readTrace("retrieval");
    const toolLoopTrace = retrievalTraces.find((trace) => trace.phase === "tool_loop");
    const toolSearchTrace = retrievalTraces.find((trace) => trace.phase === "tool_catalog_search");
    const readTrace = retrievalTraces.find((trace) => trace.phase === "read");
    const fallbackSearchTrace = retrievalTraces.find((trace) => trace.phase === "search");
    const fallbackToolLoopTrace = retrievalTraces.find((trace) => trace.phase === "tool_loop_fallback");
    assert.ok(toolLoopTrace);
    assert.ok(toolSearchTrace);
    assert.ok(readTrace);
    assert.equal(fallbackSearchTrace, undefined);
    assert.equal(fallbackToolLoopTrace, undefined);
    assert.equal(toolSearchTrace.model?.model, "tool-loop-model");
    assert.match(JSON.stringify(toolSearchTrace.output), /Searcher model selected the source card/);
    assert.equal(toolLoopTrace.status, "success");
    assert.match(JSON.stringify(toolLoopTrace.output), /projectwiki_search/);
    assert.match(JSON.stringify(toolLoopTrace.output), /projectwiki_read/);
    assert.match(JSON.stringify(toolLoopTrace.output), /Used ProjectWiki search\/read tools/);
    assert.match(JSON.stringify(readTrace.output), new RegExp(escapeRegExp(sourceCard.relativePath)));
    const contextTraces = await store.readTrace("context");
    assert.equal(contextTraces[0]?.phase, "assemble");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki propagates stale source-card health into search and curator inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-stale-health-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let curatorPrompt = "";

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const sourceCard = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Old Testing Stack",
      description: "Testing stack knowledge that later became stale.",
      summary: "The project uses Jest for API tests.",
      sourceRefs: [{ kind: "transcript", label: "fixture", contentHash: "old-stack" }],
    });
    await store.writeWikiPage({
      pageId: "knowledge",
      title: "Knowledge",
      description: "Reusable project knowledge.",
      body: "## Testing\nThe project uses Jest for API tests.",
      sourceCardIds: [sourceCard.id],
      changeSummary: "Seeded stale-source test knowledge.",
    });
    await store.markSourceCardsStale("knowledge", "The underlying source card changed.");

    const catalog = await store.listCatalog(24_000);
    const wikiEntry = catalog.find((entry) => entry.relativePath === "wiki/knowledge.md");
    assert.equal(wikiEntry?.sourceHealth?.stale, 1);
    assert.match(wikiEntry?.sourceHealth?.warnings?.[0] ?? "", /underlying source card changed/);
    const sourceEntry = catalog.find((entry) => entry.relativePath === sourceCard.relativePath);
    assert.equal(sourceEntry?.status, "stale");
    assert.match(sourceEntry?.statusReason ?? "", /underlying source card changed/);

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            if (request.outputSchema?.name === "project_wiki_search") {
              return jsonResponse({
                needsProjectWiki: true,
                selected: [{ relativePath: "wiki/knowledge.md", reason: "Relevant wiki page.", priority: 10 }],
                rejected: [],
              });
            }
            if (request.outputSchema?.name === "project_wiki_curate") {
              curatorPrompt = request.messages[0]?.content[0]?.type === "text"
                ? request.messages[0].content[0].text
                : "";
              return jsonResponse({
                sections: [{
                  title: "Testing",
                  content: "The testing-stack wiki page depends on stale evidence.",
                  sourcePaths: ["wiki/knowledge.md"],
                }],
              });
            }
            if (request.outputSchema?.name === "project_wiki_tool_search") {
              return jsonResponse({
                needsProjectWiki: true,
                selected: [{ relativePath: "wiki/knowledge.md", reason: "Tool lookup.", priority: 10 }],
                rejected: [],
              });
            }
            throw new Error(`Unexpected schema ${request.outputSchema?.name ?? "none"}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.retrieve({
      query: "What is the testing stack?",
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      recentMessages: [{
        role: "user",
        content: [{ type: "text", text: "What is the testing stack?" }],
      }],
    });

    assert.match(curatorPrompt, /sourceHealth/);
    assert.match(curatorPrompt, /stale/);
    assert.match(curatorPrompt, /underlying source card changed/);

    const tools = createProjectWikiTools(service);
    const searchTool = tools.find((tool) => tool.name === "projectwiki_search");
    assert.ok(searchTool);
    const search = await searchTool.execute({ query: "testing stack" }, toolContext(projectRoot));
    const text = search.content[0]?.type === "text" ? search.content[0].text : "";
    assert.match(text, /source health: 1 stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki marks changed and missing source references stale before search", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-source-freshness-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const repoFile = join(projectRoot, "src", "app.ts");
  const missingToolResult = join(root, "tool-results", "missing.json");
  const missingTranscript = join(root, "chats", "missing-session.jsonl");
  const changedTranscript = join(root, "chats", "changed-session.jsonl");

  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(root, "chats"), { recursive: true });
    await writeFile(repoFile, "export const stack = 'jest';\n", "utf8");
    const originalTranscriptMessages: CanonicalMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Which stack did we confirm?" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The project uses Jest for tests." }],
      },
    ];
    const changedTranscriptAssistant: CanonicalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "The project uses Vitest for tests." }],
    };
    await writeFile(changedTranscript, [
      JSON.stringify(transcriptEntry({
        type: "accepted_input",
        sessionId: "changed-session",
        turnId: "turn-1",
        sequence: 1,
        createdAt: "2026-06-20T00:00:00.000Z",
        messages: [originalTranscriptMessages[0]!],
      })),
      JSON.stringify(transcriptEntry({
        type: "assistant_message",
        sessionId: "changed-session",
        turnId: "turn-1",
        sequence: 2,
        createdAt: "2026-06-20T00:00:01.000Z",
        message: changedTranscriptAssistant,
      })),
      "",
    ].join("\n"), "utf8");
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const repoCard = await store.writeSourceCard({
      sourceType: "repo",
      title: "Repo Stack File",
      description: "Repository evidence for the test stack.",
      summary: "src/app.ts currently records Jest as the test stack.",
      sourceRefs: [{
        kind: "repo_file",
        label: "src/app.ts",
        path: repoFile,
        contentHash: sha256("export const stack = 'jest';\n"),
      }],
    });
    const toolCard = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Missing Tool Evidence",
      description: "Knowledge backed by a persisted tool result.",
      summary: "A tool result was expected to prove the test stack.",
      sourceRefs: [{
        kind: "tool_result_reference",
        label: "tool-call-1",
        path: missingToolResult,
        contentHash: "not-a-file-content-hash",
      }],
    });
    const transcriptCard = await store.writeSourceCard({
      sourceType: "conversations",
      title: "Missing Conversation Evidence",
      description: "Conversation summary backed by a transcript file.",
      summary: "A prior conversation confirmed the current test stack.",
      sourceRefs: [{
        kind: "transcript",
        label: "missing-session turn-1",
        path: missingTranscript,
        sessionId: "missing-session",
        turnId: "turn-1",
        contentHash: "turn-digest",
      }],
    });
    const changedTranscriptCard = await store.writeSourceCard({
      sourceType: "conversations",
      title: "Changed Conversation Evidence",
      description: "Conversation summary backed by a transcript turn digest.",
      summary: "A prior conversation confirmed the project uses Jest for tests.",
      sourceRefs: [{
        kind: "transcript",
        label: "changed-session turn-1",
        path: changedTranscript,
        sessionId: "changed-session",
        turnId: "turn-1",
        contentHash: sha256(freshnessDigest(originalTranscriptMessages, 16_000)),
      }],
    });
    await store.writeWikiPage({
      pageId: "knowledge",
      title: "Knowledge",
      description: "Reusable project knowledge.",
      body: "## Testing\nThe project uses Jest.",
      sourceCardIds: [repoCard.id, toolCard.id, transcriptCard.id, changedTranscriptCard.id],
      changeSummary: "Seeded freshness test knowledge.",
    });
    await writeFile(repoFile, "export const stack = 'vitest';\n", "utf8");

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_tool_search: {
            needsProjectWiki: true,
            selected: [{ relativePath: "wiki/knowledge.md", reason: "Testing knowledge.", priority: 10 }],
            rejected: [],
          },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: false }),
    });

    const search = await service.search({
      query: "testing stack",
      sessionId: "session-freshness",
      turnId: "turn-freshness",
      projectRoot,
      recentMessages: [{
        role: "user",
        content: [{ type: "text", text: "What is the testing stack?" }],
      }],
    });

    assert.equal(search.selected[0]?.sourceHealth?.stale, 4);
    assert.match(search.selected[0]?.sourceHealth?.warnings?.join("\n") ?? "", /content changed/);
    assert.match(search.selected[0]?.sourceHealth?.warnings?.join("\n") ?? "", /missing/);
    const repoCardText = await readFile(join(wikiRoot, repoCard.relativePath), "utf8");
    const toolCardText = await readFile(join(wikiRoot, toolCard.relativePath), "utf8");
    const transcriptCardText = await readFile(join(wikiRoot, transcriptCard.relativePath), "utf8");
    const changedTranscriptCardText = await readFile(join(wikiRoot, changedTranscriptCard.relativePath), "utf8");
    assert.match(repoCardText, /status: "stale"/);
    assert.match(repoCardText, /repo_file src\/app\.ts .* content changed/);
    assert.match(toolCardText, /status: "stale"/);
    assert.match(toolCardText, /tool_result_reference tool-call-1 .* is missing/);
    assert.match(transcriptCardText, /status: "stale"/);
    assert.match(transcriptCardText, /transcript missing-session turn-1 .* is missing/);
    assert.match(changedTranscriptCardText, /status: "stale"/);
    assert.match(changedTranscriptCardText, /transcript changed-session turn-1 .* content changed/);
    const traces = await store.readTrace("index");
    const freshnessTrace = traces.find((trace) => trace.phase === "source_freshness");
    assert.ok(freshnessTrace);
    assert.equal(freshnessTrace.artifacts?.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki tools expose model search and markdown reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-tools-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Testing Stack",
      description: "Reusable test-stack knowledge.",
      summary: "The project uses Jest and Supertest.",
      sourceRefs: [{ kind: "test", label: "fixture", contentHash: "abc123" }],
    });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: createToolSearchModelRuntime(),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });
    const tools = createProjectWikiTools(service);
    const searchTool = tools.find((tool) => tool.name === "projectwiki_search");
    const readTool = tools.find((tool) => tool.name === "projectwiki_read");
    assert.ok(searchTool);
    assert.ok(readTool);

    const search = await searchTool.execute({
      query: "testing stack",
      limit: 3,
    }, toolContext(projectRoot));
    assert.match(search.content[0]?.type === "text" ? search.content[0].text : "", /wiki\/knowledge\.md/);

    const read = await readTool.execute({
      relativePath: "wiki/knowledge.md",
      maxChars: 4_000,
    }, toolContext(projectRoot));
    assert.match(read.content[0]?.type === "text" ? read.content[0].text : "", /Knowledge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki repo indexing detects digest changes and marks older repo cards stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-repo-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# First\n", "utf8");
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: createRepoIndexModelRuntime(),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: true, memory: false, conversations: false, knowledge: false }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-1"));
    await service.flushMaintenance();
    await writeFile(join(projectRoot, "README.md"), "# Second\n", "utf8");
    await service.captureTurn(captureInput(projectRoot, "turn-2"));
    await service.flushMaintenance();

    const cards = (await readdir(join(wikiRoot, "source_cards", "repo"))).sort();
    assert.equal(cards.length, 2);
    const first = await readFile(join(wikiRoot, "source_cards", "repo", cards[0]!), "utf8");
    const second = await readFile(join(wikiRoot, "source_cards", "repo", cards[1]!), "utf8");
    assert.match(first + second, /status: "stale"/);
    assert.match(first + second, /Repository digest changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki repo indexing includes nested source files and skips generated directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-repo-digest-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let capturedDigest = "";

  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await mkdir(join(projectRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(projectRoot, "project_wiki", "wiki"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Nested Repo\n", "utf8");
    await writeFile(
      join(projectRoot, "src", "app.ts"),
      "export const nestedProjectSignal = 'repo source card should see this';\n",
      "utf8",
    );
    await writeFile(join(projectRoot, "dist", "generated.ts"), "generatedNoise();\n", "utf8");
    await writeFile(join(projectRoot, "node_modules", "pkg", "index.ts"), "dependencyNoise();\n", "utf8");
    await writeFile(join(projectRoot, "project_wiki", "wiki", "knowledge.md"), "selfReferenceNoise();\n", "utf8");

    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: createRepoDigestCaptureModelRuntime((digest) => {
          capturedDigest = digest;
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: true, memory: false, conversations: false, knowledge: false }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-1"));
    await service.flushMaintenance();

    assert.match(capturedDigest, /Repository tree sample/);
    assert.match(capturedDigest, /src\/app\.ts/);
    assert.match(capturedDigest, /nestedProjectSignal/);
    assert.doesNotMatch(capturedDigest, /dist\/generated\.ts/);
    assert.doesNotMatch(capturedDigest, /node_modules\/pkg\/index\.ts/);
    assert.doesNotMatch(capturedDigest, /project_wiki\/wiki\/knowledge\.md/);

    const repoCards = await readdir(join(wikiRoot, "source_cards", "repo"));
    assert.equal(repoCards.length, 1);
    const repoCard = await readFile(join(wikiRoot, "source_cards", "repo", repoCards[0]!), "utf8");
    assert.match(repoCard, /repo_file/);
    assert.match(repoCard, new RegExp(`"path":"${escapeRegExp(join(projectRoot, "src", "app.ts"))}"`));
    assert.match(repoCard, /label":"src\/app\.ts"/);
    assert.match(repoCard, /range=1-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki maintainer runs in the background and flushes queued wiki updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-async-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const releaseMaintainer = deferred<void>();

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Async Knowledge",
              description: "Knowledge that should be refined asynchronously.",
              summary: "The maintainer should not block captureTurn.",
            }],
          },
          project_wiki_maintain: async () => {
            await releaseMaintainer.promise;
            return {
              pages: [{
                pageId: "knowledge",
                title: "Knowledge",
                description: "Reusable project knowledge.",
                body: "## Async\nMaintainer flushed after capture returned.",
                sourceCardIds: [],
                changeSummary: "Async maintainer completed.",
              }],
            };
          },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 5_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-1"));
    const beforeFlush = await readFile(join(wikiRoot, "wiki", "knowledge.md"), "utf8");
    assert.doesNotMatch(beforeFlush, /Maintainer flushed after capture returned/);

    releaseMaintainer.resolve();
    await service.flushMaintenance();

    const afterFlush = await readFile(join(wikiRoot, "wiki", "knowledge.md"), "utf8");
    assert.match(afterFlush, /Maintainer flushed after capture returned/);
    assert.match(afterFlush, /sourceCardIds:\n  - "sc_/);
  } finally {
    releaseMaintainer.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki captureTurn queues indexing without blocking turn completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-nonblocking-capture-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const releaseIndexer = deferred<void>();
  let indexerStarted = false;
  let service: ProjectWikiService | undefined;

  try {
    await mkdir(projectRoot, { recursive: true });
    service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: async () => {
            indexerStarted = true;
            await releaseIndexer.promise;
            return {
              cards: [{
                sourceType: "knowledge",
                title: "Nonblocking Capture",
                description: "Knowledge produced after captureTurn returned.",
                summary: "captureTurn should not wait for the ProjectWiki indexer model.",
              }],
            };
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 5_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-1"));
    await waitUntil(() => indexerStarted);
    assert.equal(indexerStarted, true);
    assert.deepEqual(await readDirectoryEntries(join(wikiRoot, "source_cards", "knowledge")), []);

    releaseIndexer.resolve();
    await service.flushMaintenance();

    const cards = await readDirectoryEntries(join(wikiRoot, "source_cards", "knowledge"));
    assert.equal(cards.length, 1);
  } finally {
    releaseIndexer.resolve();
    await service?.flushMaintenance();
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki captureTurn queues repo digest indexing without blocking turn completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-nonblocking-repo-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const releaseRepoDigest = deferred<void>();
  let repoDigestStarted = false;
  let service: ProjectWikiService | undefined;

  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Repo\n", "utf8");
    service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_repo_index: {
            cards: [{
              sourceType: "repo",
              title: "Queued Repo Digest",
              description: "Repository knowledge produced after captureTurn returned.",
              summary: "captureTurn should not wait for ProjectWiki repo digest indexing.",
            }],
          },
          project_wiki_maintain: { pages: [] },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 5_000,
      }),
      config: projectWikiConfig({ repo: true, memory: false, conversations: false, knowledge: false }),
      repoDigestBuilder: async (rootPath) => {
        repoDigestStarted = true;
        await releaseRepoDigest.promise;
        return {
          digest: `Project root: ${rootPath}\nImportant file snippets:\n--- README.md ---\n# Repo`,
          sourceRefs: [{
            kind: "repo_file",
            label: "README.md",
            path: join(projectRoot, "README.md"),
            range: { startLine: 1, endLine: 1 },
            contentHash: "queued-repo-digest",
          }],
          files: [{
            relativePath: "README.md",
            path: join(projectRoot, "README.md"),
            size: 7,
            contentHash: "queued-repo-digest",
            lineCount: 1,
          }],
        };
      },
    });

    const capture = service.captureTurn(captureInput(projectRoot, "turn-repo"));
    const captureResult = await Promise.race([
      capture.then(() => "done"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    assert.equal(captureResult, "done");
    await waitUntil(() => repoDigestStarted);
    assert.deepEqual(await readDirectoryEntries(join(wikiRoot, "source_cards", "repo")), []);

    releaseRepoDigest.resolve();
    await service.flushMaintenance();

    const cards = await readDirectoryEntries(join(wikiRoot, "source_cards", "repo"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "repo", cards[0]!), "utf8");
    assert.match(card, /Queued Repo Digest/);
    assert.match(card, /repo_file/);
  } finally {
    releaseRepoDigest.resolve();
    await service?.flushMaintenance();
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki refresh runs repo indexer and maintainer before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-refresh-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let repoIndexerCalled = false;
  let maintainerCalled = false;

  try {
    await mkdir(projectRoot, { recursive: true });
    const readmePath = join(projectRoot, "README.md");
    await writeFile(readmePath, "# Refresh Fixture\n", "utf8");
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            const schemaName = request.outputSchema?.name ?? "";
            if (schemaName === "project_wiki_repo_index") {
              repoIndexerCalled = true;
              return jsonResponse({
                cards: [{
                  sourceType: "repo",
                  title: "Refresh Repo Snapshot",
                  description: "Repository summary produced by manual ProjectWiki refresh.",
                  summary: "The refresh path indexed the repository README.",
                  evidenceLevel: "high",
                  confidence: 0.95,
                }],
              });
            }
            if (schemaName === "project_wiki_maintain") {
              maintainerCalled = true;
              const first = request.messages[0]?.content[0];
              const prompt = first?.type === "text" ? first.text : "";
              const maintainerInput = JSON.parse(prompt) as {
                newSourceCards?: Array<{ id: string }>;
              };
              const cardId = maintainerInput.newSourceCards?.[0]?.id;
              return jsonResponse({
                pages: [{
                  pageId: "project-overview",
                  title: "Project Overview",
                  description: "Repository overview refined during manual refresh.",
                  body: "## Repository\nThe ProjectWiki refresh path indexed the repository README.",
                  sourceCardIds: cardId ? [cardId] : [],
                  changeSummary: "Manual refresh folded repo evidence into the overview.",
                }],
              });
            }
            throw new Error(`Unexpected schema ${schemaName}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "refresh-model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: true, memory: false, conversations: false, knowledge: false }),
      repoDigestBuilder: async () => ({
        digest: "Project root: fixture\nImportant file snippets:\n--- README.md ---\n# Refresh Fixture",
        sourceRefs: [{
          kind: "repo_file",
          label: "README.md",
          path: readmePath,
          range: { startLine: 1, endLine: 1 },
          contentHash: sha256("# Refresh Fixture\n"),
        }],
        files: [{
          relativePath: "README.md",
          path: readmePath,
          size: 18,
          contentHash: sha256("# Refresh Fixture\n"),
          lineCount: 1,
        }],
      }),
    });

    const result = await service.refresh({ reason: "dashboard_refresh" });

    assert.equal(result.refreshed, true);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(repoIndexerCalled, true);
    assert.equal(maintainerCalled, true);
    const cards = await readDirectoryEntries(join(wikiRoot, "source_cards", "repo"));
    assert.equal(cards.length, 1);
    const overview = await readFile(join(wikiRoot, "wiki", "project-overview.md"), "utf8");
    assert.match(overview, /ProjectWiki refresh path indexed the repository README/);
    assert.match(overview, /sourceCardIds:/);
    const indexTraces = await store.readTrace("index");
    const maintainTraces = await store.readTrace("maintain");
    assert.ok(indexTraces.some((trace) => trace.phase === "repo"));
    assert.ok(maintainTraces.some((trace) => trace.phase === "wiki"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki legacy memory import reads current workspace project and feedback records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-legacy-memory-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const legacyMemoryRoot = join(root, "memory");
  const workspaceKey = createHash("sha1").update(projectRoot).digest("hex").slice(0, 10);
  const workspaceMemoryDir = join(legacyMemoryRoot, "workspaces", workspaceKey, "memory");
  let importedPaths: string[] = [];
  let importedContent = "";

  try {
    await mkdir(join(workspaceMemoryDir, "Project"), { recursive: true });
    await mkdir(join(workspaceMemoryDir, "Feedback"), { recursive: true });
    await mkdir(join(wikiRoot, "state"), { recursive: true });
    await writeFile(
      join(wikiRoot, "state", "legacy-memory-imported"),
      "2026-06-24T00:00:00.000Z",
      "utf8",
    );
    await writeFile(join(workspaceMemoryDir, "project.meta.md"), [
      "---",
      "project_id: demo-project",
      "project_name: Demo Project",
      `workspace_path: ${projectRoot}`,
      "---",
      "",
      "## Summary",
      "Project metadata anchors the legacy workspace.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(workspaceMemoryDir, "Project", "status.md"), [
      "---",
      "name: Legacy Project Status",
      "type: project",
      "scope: project",
      "project_id: demo-project",
      "---",
      "",
      "## Project Note",
      "The legacy project memory says the launch deadline is Friday.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(workspaceMemoryDir, "Feedback", "style.md"), [
      "---",
      "name: Legacy Feedback Rule",
      "type: feedback",
      "scope: project",
      "project_id: demo-project",
      "---",
      "",
      "## Feedback Note",
      "The legacy feedback memory says replies should be concise and Chinese.",
      "",
    ].join("\n"), "utf8");

    const modelRuntime: ModelRuntime = {
      async *stream() {
        throw new Error("stream should not be called");
      },
      async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
        const schemaName = request.outputSchema?.name ?? "";
        if (schemaName === "project_wiki_legacy_memory_index") {
          const first = request.messages[0]?.content[0];
          const parsed = JSON.parse(first?.type === "text" ? first.text : "{}") as {
            files?: Array<{ path?: string; content?: string }>;
          };
          importedPaths = (parsed.files ?? []).map((file) => file.path ?? "");
          importedContent = (parsed.files ?? []).map((file) => file.content ?? "").join("\n\n");
          return jsonResponse({
            cards: [{
              sourceType: "memory",
              title: "Imported legacy memory",
              description: "Legacy project and feedback memory imported into ProjectWiki.",
              summary: "The legacy memory includes the Friday launch deadline and concise Chinese reply preference.",
            }],
          });
        }
        if (schemaName === "project_wiki_maintain") {
          return jsonResponse({ pages: [] });
        }
        throw new Error(`Unexpected schema ${schemaName}`);
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
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime,
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: true, conversations: false, knowledge: false }),
      legacyMemoryRootDir: legacyMemoryRoot,
    });

    const result = await service.refresh({ reason: "test_legacy_memory_import" });

    assert.equal(result.refreshed, true);
    assert.ok(importedPaths.some((filePath) => filePath.endsWith("Project/status.md")));
    assert.ok(importedPaths.some((filePath) => filePath.endsWith("Feedback/style.md")));
    assert.match(importedContent, /launch deadline is Friday/);
    assert.match(importedContent, /concise and Chinese/);

    const cards = await readdir(join(wikiRoot, "source_cards", "memory"));
    assert.equal(cards.length, 1);
    const card = await readFile(join(wikiRoot, "source_cards", "memory", cards[0]!), "utf8");
    assert.match(card, /Imported legacy memory/);
    assert.match(card, /Project\/status\.md/);
    assert.match(card, /Feedback\/style\.md/);

    const migration = JSON.parse(await readFile(join(wikiRoot, "state", "migrations", "legacy-memory-v1.json"), "utf8")) as {
      version?: number;
      status?: string;
      sourceFiles?: number;
      createdSourceCards?: number;
      sourceCardPaths?: string[];
    };
    assert.equal(migration.version, 1);
    assert.equal(migration.status, "completed");
    assert.ok((migration.sourceFiles ?? 0) >= 3);
    assert.equal(migration.createdSourceCards, 1);
    assert.equal(migration.sourceCardPaths?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki refresh backfills completed transcript turns only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-history-refresh-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const chatDir = join(root, "chats");
  const transcriptPath = join(chatDir, "session-history.jsonl");
  const indexedTurns: string[] = [];

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(chatDir, { recursive: true });
    const sessionId = "session-history";
    const transcriptRows = [
      transcriptEntry({
        type: "accepted_input",
        sessionId,
        turnId: "turn-1",
        sequence: 1,
        createdAt: "2026-06-20T00:00:00.000Z",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "The project test stack is Jest and Supertest." }],
        }],
      }),
      transcriptEntry({
        type: "assistant_message",
        sessionId,
        turnId: "turn-1",
        sequence: 2,
        createdAt: "2026-06-20T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Noted: Jest handles assertions and Supertest handles HTTP requests." }],
        },
      }),
      transcriptEntry({
        type: "turn_result",
        sessionId,
        turnId: "turn-1",
        sequence: 3,
        createdAt: "2026-06-20T00:00:02.000Z",
        result: turnResult(sessionId, "turn-1", "2026-06-20T00:00:00.000Z", "2026-06-20T00:00:02.000Z"),
      }),
      transcriptEntry({
        type: "accepted_input",
        sessionId,
        turnId: "turn-2",
        sequence: 4,
        createdAt: "2026-06-20T00:01:00.000Z",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "The user prefers source-backed wiki summaries." }],
        }],
      }),
      transcriptEntry({
        type: "assistant_message",
        sessionId,
        turnId: "turn-2",
        sequence: 5,
        createdAt: "2026-06-20T00:01:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ProjectWiki summaries should keep source references visible." }],
        },
      }),
      transcriptEntry({
        type: "turn_result",
        sessionId,
        turnId: "turn-2",
        sequence: 6,
        createdAt: "2026-06-20T00:01:02.000Z",
        result: turnResult(sessionId, "turn-2", "2026-06-20T00:01:00.000Z", "2026-06-20T00:01:02.000Z"),
      }),
      transcriptEntry({
        type: "accepted_input",
        sessionId,
        turnId: "turn-incomplete",
        sequence: 7,
        createdAt: "2026-06-20T00:02:00.000Z",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "This unfinished turn should not be indexed." }],
        }],
      }),
    ];
    await writeFile(transcriptPath, `${transcriptRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            const schemaName = request.outputSchema?.name ?? "";
            if (schemaName === "project_wiki_index") {
              const first = request.messages[0]?.content[0];
              const prompt = first?.type === "text" ? first.text : "{}";
              const parsed = JSON.parse(prompt) as { turnId?: string; messages?: string; sourceRefs?: unknown[] };
              assert.match(parsed.messages ?? "", /ProjectWiki|Jest|Supertest/);
              assert.match(JSON.stringify(parsed.sourceRefs), new RegExp(escapeRegExp(transcriptPath)));
              indexedTurns.push(parsed.turnId ?? "");
              return jsonResponse({
                cards: [{
                  sourceType: "conversations",
                  title: `Historical ${parsed.turnId}`,
                  description: "Backfilled transcript turn.",
                  summary: `Backfilled ${parsed.turnId} from transcript history.`,
                }],
              });
            }
            if (schemaName === "project_wiki_maintain") {
              return jsonResponse({ pages: [] });
            }
            throw new Error(`Unexpected schema ${schemaName}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "history-refresh-model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: true, knowledge: false }),
      chatDir,
    });

    const firstRefresh = await service.refresh({ reason: "dashboard_refresh", maxHistoricalTurns: 10 });

    assert.equal(firstRefresh.refreshed, true);
    assert.equal(firstRefresh.scannedTranscripts, 1);
    assert.equal(firstRefresh.discoveredTurns, 2);
    assert.equal(firstRefresh.indexedTurns, 2);
    assert.equal(firstRefresh.failedTurns, 0);
    assert.equal(firstRefresh.sourceCardsCreated, 2);
    assert.deepEqual(indexedTurns, ["turn-1", "turn-2"]);
    const cards = await readDirectoryEntries(join(wikiRoot, "source_cards", "conversations"));
    assert.equal(cards.length, 2);
    const firstCard = await readFile(join(wikiRoot, "source_cards", "conversations", cards[0]!), "utf8");
    assert.match(firstCard, new RegExp(escapeRegExp(transcriptPath)));
    assert.doesNotMatch(firstCard, /turn-incomplete/);
    const traces = await store.readTrace("index");
    assert.ok(traces.some((trace) => trace.phase === "history_backfill" && trace.status === "success"));

    const secondRefresh = await service.refresh({ reason: "dashboard_refresh", maxHistoricalTurns: 10 });
    assert.equal(secondRefresh.indexedTurns, 0);
    assert.equal(secondRefresh.skippedTurns, 2);
    assert.equal(secondRefresh.sourceCardsCreated, 0);
    assert.deepEqual(indexedTurns, ["turn-1", "turn-2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki refresh reports and clamps the historical backfill limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-history-limit-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const service = new ProjectWikiService({
      projectRoot,
      store: new ProjectWikiStore({ rootDir: wikiRoot, projectRoot }),
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({}),
        models: {},
        fallbackModel: { provider: "test", model: "limit-model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: false }),
      chatDir: join(root, "chats"),
    });

    const clamped = await service.refresh({ reason: "dashboard_refresh", maxHistoricalTurns: 9999 });
    assert.equal(clamped.maxHistoricalTurns, 120);

    const explicit = await service.refresh({ reason: "dashboard_refresh", maxHistoricalTurns: 4 });
    assert.equal(explicit.maxHistoricalTurns, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki maintainer preserves failed source cards and resumes them on the next turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-maintenance-retry-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let recoveredMaintainPrompt = "";

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const failedService = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: modelRuntimeForSchemas({
          project_wiki_index: {
            cards: [{
              sourceType: "knowledge",
              title: "Recoverable Knowledge",
              description: "A card that should stay pending after maintainer failure.",
              summary: "Recovered pending cards must reach the next maintainer run.",
            }],
          },
          project_wiki_maintain: () => {
            throw new Error("temporary maintainer failure");
          },
        }),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await failedService.captureTurn(captureInput(projectRoot, "turn-1"));
    await failedService.flushMaintenance();

    assert.equal(await store.hasPendingMaintenanceCards(), true);
    const failedTraces = await store.readTrace("maintain");
    assert.equal(failedTraces[0]?.phase, "wiki_failed");

    const recoveredService = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            if (request.outputSchema?.name === "project_wiki_index") {
              return jsonResponse({ cards: [] });
            }
            if (request.outputSchema?.name === "project_wiki_maintain") {
              recoveredMaintainPrompt = request.messages[0]?.content[0]?.type === "text"
                ? request.messages[0].content[0].text
                : "";
              return jsonResponse({
                pages: [{
                  pageId: "knowledge",
                  title: "Knowledge",
                  description: "Reusable project knowledge.",
                  body: "## Recovered\nRecovered pending cards were refined after a maintainer retry.",
                  sourceCardIds: [],
                  changeSummary: "Recovered pending maintenance work.",
                }],
              });
            }
            throw new Error(`Unexpected schema ${request.outputSchema?.name ?? "none"}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await recoveredService.captureTurn(captureInput(projectRoot, "turn-2"));
    await recoveredService.flushMaintenance();

    assert.match(recoveredMaintainPrompt, /Recoverable Knowledge/);
    assert.equal(await store.hasPendingMaintenanceCards(), false);
    const recoveredPage = await readFile(join(wikiRoot, "wiki", "knowledge.md"), "utf8");
    assert.match(recoveredPage, /Recovered pending cards were refined/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki maintainer conflicts are persisted as durable traceability records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-conflicts-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: createConflictModelRuntime(),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: true, knowledge: false }),
    });

    await service.captureTurn(captureInput(projectRoot, "turn-1"));
    await service.captureTurn(captureInput(projectRoot, "turn-2"));
    await service.flushMaintenance();

    const conflicts = await store.readConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.topic, "Conflicting test stack");
    assert.match(conflicts[0]?.summary ?? "", /Jest/);
    assert.ok(conflicts[0]?.traceId);
    const maintainTraces = await store.readTrace("maintain");
    assert.ok(maintainTraces.some((trace) => trace.id === conflicts[0]?.traceId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki conflict status updates are append-only and reopenable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-conflict-status-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const [conflict] = await store.appendConflicts([{
      topic: "Test stack conflict",
      summary: "Jest and Vitest are both mentioned.",
      sourceCardIds: ["sc_one", "sc_two"],
    }], "trace-1");
    assert.ok(conflict);

    const resolved = await store.updateConflictStatus(conflict.id, "resolved");
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.createdAt, conflict.createdAt);
    assert.deepEqual(resolved?.sourceCardIds, ["sc_one", "sc_two"]);
    assert.equal((await store.readConflicts())[0]?.status, "resolved");

    const reopened = await store.updateConflictStatus(conflict.id, "open");
    assert.equal(reopened?.status, "open");
    assert.equal((await store.readConflicts())[0]?.status, "open");

    const raw = await readFile(join(wikiRoot, "conflicts", "conflicts.jsonl"), "utf8");
    assert.equal(raw.split(/\r?\n/).filter(Boolean).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard snapshot deduplicates append-only conflicts by id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-conflicts-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiSnapshot: (projectPath: string, options?: { traceLimit?: number }) => Promise<{
        conflicts: Array<{ id?: string; status?: string; summary?: string }>;
        stats: { conflicts: number; openConflicts: number };
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
      updateProjectWikiConflictStatus: (
        projectPath: string,
        conflictId: string,
        status: "open" | "resolved",
      ) => Promise<{ id?: string; status?: string }>;
    };
    const { readProjectWikiSnapshot, resolveProjectWikiRoot, updateProjectWikiConflictStatus } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "conflicts"), { recursive: true });
    await writeFile(join(rootDir, "conflicts", "conflicts.jsonl"), [
      JSON.stringify({
        id: "conflict-1",
        pageId: "knowledge",
        status: "open",
        topic: "Test stack",
        summary: "Jest or Vitest?",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "conflict-1",
        pageId: "knowledge",
        status: "resolved",
        topic: "Test stack",
        summary: "Resolved to Jest.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
      }),
      JSON.stringify({
        id: "conflict-2",
        pageId: "project-status",
        status: "open",
        topic: "Next step",
        summary: "Need a follow-up decision.",
        createdAt: "2026-01-01T00:05:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
      }),
    ].join("\n"), "utf8");

    const snapshot = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(snapshot.conflicts.length, 2);
    assert.equal(snapshot.stats.conflicts, 2);
    assert.equal(snapshot.stats.openConflicts, 1);
    assert.equal(snapshot.conflicts.find((conflict) => conflict.id === "conflict-1")?.status, "resolved");
    assert.equal(snapshot.conflicts.find((conflict) => conflict.id === "conflict-1")?.summary, "Resolved to Jest.");

    const updated = await updateProjectWikiConflictStatus(projectRoot, "conflict-2", "resolved");
    assert.equal(updated.status, "resolved");
    const afterResolve = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(afterResolve.stats.openConflicts, 0);
    assert.equal(afterResolve.conflicts.find((conflict) => conflict.id === "conflict-2")?.status, "resolved");

    await updateProjectWikiConflictStatus(projectRoot, "conflict-2", "open");
    const afterReopen = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(afterReopen.stats.openConflicts, 1);
    assert.equal(afterReopen.conflicts.find((conflict) => conflict.id === "conflict-2")?.status, "open");
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard refresh normalizes historical backfill limits", async () => {
  const limitsModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiRefreshLimits.js")).href) as {
    DASHBOARD_REFRESH_DEFAULT_MAX_HISTORICAL_TURNS: number;
    DASHBOARD_REFRESH_MAX_HISTORICAL_TURNS: number;
    normalizeRefreshMaxHistoricalTurns: (value: unknown) => number;
  };
  assert.equal(limitsModule.DASHBOARD_REFRESH_DEFAULT_MAX_HISTORICAL_TURNS, 25);
  assert.equal(limitsModule.DASHBOARD_REFRESH_MAX_HISTORICAL_TURNS, 120);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns(undefined), 25);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns("12"), 12);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns("3.9"), 3);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns("1000"), 120);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns("-1"), 25);
  assert.equal(limitsModule.normalizeRefreshMaxHistoricalTurns("not-a-number"), 25);
});

test("ProjectWiki dashboard snapshot is read-only and does not repair files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-readonly-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiSnapshot: (projectPath: string, options?: { traceLimit?: number }) => Promise<{
        exists: boolean;
        sourceCards: Array<{ relativePath?: string }>;
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiSnapshot, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "source_cards", "knowledge"), { recursive: true });
    await mkdir(join(rootDir, "wiki"), { recursive: true });
    await mkdir(join(rootDir, "..", "chats"), { recursive: true });
    await writeFile(join(rootDir, "..", "chats", "session-1.jsonl"), "{}\n", "utf8");

    const staleHome = [
      "---",
      "type: \"project_wiki_home\"",
      "title: \"ProjectWiki\"",
      "description: \"Old home\"",
      "---",
      "",
      "# ProjectWiki",
      "",
      "- `wiki/collaboration-context.md`: old page.",
      "",
    ].join("\n");
    const sourceCard = [
      "---",
      "id: \"sc_readonly\"",
      "type: \"source_card\"",
      "sourceType: \"knowledge\"",
      "title: \"Read-only source card\"",
      "description: \"A source card with a repairable transcript ref.\"",
      "status: \"active\"",
      "createdAt: \"2026-01-01T00:00:00.000Z\"",
      "updatedAt: \"2026-01-01T00:00:00.000Z\"",
      "sourceRefs:",
      "  - {\"kind\":\"transcript\",\"label\":\"turn\",\"sessionId\":\"session-1\"}",
      "---",
      "",
      "# Read-only source card",
      "",
      "## Summary",
      "This card should not be rewritten by snapshot reads.",
      "",
      "## Source References",
      "- transcript | turn | session=session-1",
      "",
    ].join("\n");
    const homePath = join(rootDir, "home.md");
    const sourcePath = join(rootDir, "source_cards", "knowledge", "sc_readonly.md");
    await writeFile(homePath, staleHome, "utf8");
    await writeFile(sourcePath, sourceCard, "utf8");

    const snapshot = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.sourceCards.length, 1);
    assert.equal(await readFile(homePath, "utf8"), staleHome);
    assert.equal(await readFile(sourcePath, "utf8"), sourceCard);
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard reads raw trace payloads from the payload directory only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-payload-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiPayload: (projectPath: string, relativePath: string) => Promise<{
        relativePath: string;
        content: string;
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiPayload, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "traces", "payloads"), { recursive: true });
    await writeFile(
      join(rootDir, "traces", "payloads", "trace-input.json"),
      JSON.stringify({ catalog: [{ relativePath: "wiki/knowledge.md" }] }, null, 2),
      "utf8",
    );
    await writeFile(join(rootDir, "home.md"), "# Not a payload\n", "utf8");

    const payload = await readProjectWikiPayload(projectRoot, "traces/payloads/trace-input.json");
    assert.equal(payload.relativePath, "traces/payloads/trace-input.json");
    assert.match(payload.content, /wiki\/knowledge\.md/);
    await assert.rejects(
      () => readProjectWikiPayload(projectRoot, "home.md"),
      /trace payload path/,
    );
    await assert.rejects(
      () => readProjectWikiPayload(projectRoot, "traces/payloads/../../home.md"),
      /trace payload path/,
    );
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard file reads are limited to canonical wiki markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-file-boundary-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiFile: (projectPath: string, relativePath: string) => Promise<{
        relativePath: string;
        content: string;
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiFile, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "source_cards", "knowledge"), { recursive: true });
    await mkdir(join(rootDir, "state"), { recursive: true });
    await writeFile(join(rootDir, "source_cards", "knowledge", "sc_allowed.md"), "# Allowed\n", "utf8");
    await writeFile(join(rootDir, "state", "debug.md"), "# Internal\n", "utf8");

    const file = await readProjectWikiFile(projectRoot, "source_cards/knowledge/sc_allowed.md");
    assert.equal(file.relativePath, "source_cards/knowledge/sc_allowed.md");
    assert.match(file.content, /Allowed/);
    await assert.rejects(
      () => readProjectWikiFile(projectRoot, "state/debug.md"),
      /canonical ProjectWiki markdown path/,
    );
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard snapshot derives stale health for source cards with unsupported refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-derived-health-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiSnapshot: (projectPath: string, options?: { traceLimit?: number }) => Promise<{
        sourceCards: Array<{ frontmatter?: { status?: string; statusReason?: string } }>;
        stats: { staleSourceCards?: number };
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiSnapshot, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "source_cards", "repo"), { recursive: true });
    const sourceCard = [
      "---",
      "id: \"sc_repo_transcript_only\"",
      "type: \"source_card\"",
      "sourceType: \"repo\"",
      "title: \"Transcript Backed Repo Card\"",
      "description: \"An older repo card backed only by conversation material.\"",
      "status: \"active\"",
      "createdAt: \"2026-01-01T00:00:00.000Z\"",
      "updatedAt: \"2026-01-01T00:00:00.000Z\"",
      "sourceRefs:",
      "  - {\"kind\":\"transcript\",\"label\":\"turn\",\"sessionId\":\"session-1\"}",
      "---",
      "",
      "# Transcript Backed Repo Card",
      "",
      "## Summary",
      "This card should be displayed as stale without rewriting the file.",
      "",
      "## Source References",
      "- transcript | turn | session=session-1",
      "",
    ].join("\n");
    const sourcePath = join(rootDir, "source_cards", "repo", "sc_repo_transcript_only.md");
    await writeFile(sourcePath, sourceCard, "utf8");

    const snapshot = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(snapshot.stats.staleSourceCards, 1);
    assert.equal(snapshot.sourceCards[0]?.frontmatter?.status, "stale");
    assert.match(snapshot.sourceCards[0]?.frontmatter?.statusReason ?? "", /not backed by repository source refs/);
    assert.equal(await readFile(sourcePath, "utf8"), sourceCard);
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard snapshot surfaces stale source health on linked wiki pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-source-health-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiSnapshot: (projectPath: string, options?: { traceLimit?: number }) => Promise<{
        wikiPages: Array<{ pageId?: string; sourceHealth?: { stale?: number; warnings?: string[] } }>;
        stats: { staleSourceCards?: number; staleWikiPages?: number };
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiSnapshot, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "source_cards", "knowledge"), { recursive: true });
    await mkdir(join(rootDir, "wiki"), { recursive: true });
    await writeFile(join(rootDir, "source_cards", "knowledge", "sc_stale.md"), [
      "---",
      "id: \"sc_stale\"",
      "type: \"source_card\"",
      "sourceType: \"knowledge\"",
      "title: \"Old Testing Stack\"",
      "description: \"Testing stack knowledge.\"",
      "status: \"stale\"",
      "statusReason: \"Repository digest changed.\"",
      "createdAt: \"2026-01-01T00:00:00.000Z\"",
      "updatedAt: \"2026-01-01T00:10:00.000Z\"",
      "sourceRefs: []",
      "---",
      "",
      "# Old Testing Stack",
      "",
      "## Summary",
      "The project used Jest for API tests.",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(rootDir, "wiki", "knowledge.md"), [
      "---",
      "type: \"wiki_page\"",
      "pageId: \"knowledge\"",
      "title: \"Knowledge\"",
      "description: \"Reusable project knowledge.\"",
      "updatedAt: \"2026-01-01T00:10:00.000Z\"",
      "sourceCardIds:",
      "  - \"sc_stale\"",
      "---",
      "",
      "# Knowledge",
      "",
      "## Testing",
      "The project used Jest for API tests.",
      "",
    ].join("\n"), "utf8");

    const snapshot = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(snapshot.stats.staleSourceCards, 1);
    assert.equal(snapshot.stats.staleWikiPages, 1);
    const knowledge = snapshot.wikiPages.find((page) => page.pageId === "knowledge");
    assert.equal(knowledge?.sourceHealth?.stale, 1);
    assert.match(knowledge?.sourceHealth?.warnings?.[0] ?? "", /Repository digest changed/);
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard snapshot exposes pending maintainer queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-dashboard-maintenance-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = pilotHome;
    await mkdir(projectRoot, { recursive: true });
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      readProjectWikiSnapshot: (projectPath: string, options?: { traceLimit?: number }) => Promise<{
        maintenance?: {
          pending: Array<{ key?: string; title?: string; sourceType?: string; relativePath?: string }>;
          processed: Array<{ key?: string; traceId?: string }>;
          pendingByType?: Record<string, number>;
        };
        stats: { pendingMaintenanceCards?: number; processedMaintenanceCards?: number };
      }>;
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ rootDir: string }>;
    };
    const { readProjectWikiSnapshot, resolveProjectWikiRoot } = serviceModule;
    const { rootDir } = await resolveProjectWikiRoot(projectRoot);
    await mkdir(join(rootDir, "state"), { recursive: true });
    await writeFile(join(rootDir, "state", "wiki-maintenance.jsonl"), [
      JSON.stringify({
        op: "enqueue",
        key: "knowledge:sc_pending",
        cardId: "sc_pending",
        relativePath: "source_cards/knowledge/sc_pending.md",
        sourceType: "knowledge",
        title: "Pending Knowledge",
        queuedAt: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        op: "enqueue",
        key: "repo:sc_done",
        cardId: "sc_done",
        relativePath: "source_cards/repo/sc_done.md",
        sourceType: "repo",
        title: "Processed Repo",
        queuedAt: "2026-01-01T00:01:00.000Z",
      }),
      JSON.stringify({
        op: "processed",
        key: "repo:sc_done",
        cardId: "sc_done",
        relativePath: "source_cards/repo/sc_done.md",
        processedAt: "2026-01-01T00:02:00.000Z",
        traceId: "trace-maintain",
      }),
    ].join("\n"), "utf8");

    const snapshot = await readProjectWikiSnapshot(projectRoot, { traceLimit: 20 });
    assert.equal(snapshot.stats.pendingMaintenanceCards, 1);
    assert.equal(snapshot.stats.processedMaintenanceCards, 1);
    assert.equal(snapshot.maintenance?.pending.length, 1);
    assert.equal(snapshot.maintenance?.pending[0]?.title, "Pending Knowledge");
    assert.equal(snapshot.maintenance?.pending[0]?.sourceType, "knowledge");
    assert.equal(snapshot.maintenance?.pendingByType?.knowledge, 1);
    assert.equal(snapshot.maintenance?.pendingByType?.repo, 0);
    assert.equal(snapshot.maintenance?.processed[0]?.traceId, "trace-maintain");
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime env never exposes legacy memory service variables", async () => {
  const configModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/pilotdeckConfig.js")).href) as {
    buildRuntimeEnv: (config: unknown) => Record<string, string>;
  };
  const { buildRuntimeEnv } = configModule;
  const modelConfig = {
    agent: { model: "local/main" },
    model: {
      providers: {
        local: {
          protocol: "openai",
          url: "http://localhost:1234/v1",
          apiKey: "test-key",
          models: { main: {} },
        },
      },
    },
  };

  const projectWikiEnv = buildRuntimeEnv({
    ...modelConfig,
    memory: { enabled: true },
    projectWiki: { enabled: true },
  });
  assert.equal(projectWikiEnv.PILOTDECK_MEMORY_ENABLED, undefined);
  assert.equal(projectWikiEnv.PILOTDECK_MEMORY_MODEL, undefined);
  assert.equal(projectWikiEnv.PILOTDECK_MEMORY_API_KEY, undefined);

  const legacyEnv = buildRuntimeEnv({
    ...modelConfig,
    memory: { enabled: true },
    projectWiki: { enabled: false },
    customEnv: { PILOTDECK_MEMORY_MODEL: "should-not-leak" },
  });
  assert.equal(legacyEnv.PILOTDECK_MEMORY_ENABLED, undefined);
  assert.equal(legacyEnv.PILOTDECK_MEMORY_MODEL, undefined);
  assert.equal(legacyEnv.PILOTDECK_MEMORY_API_KEY, undefined);
});

test("legacy memory dashboard becomes a ProjectWiki bridge when ProjectWiki is enabled", async () => {
  const bridgeModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiLegacyBridge.js")).href) as {
    renderProjectWikiDashboardBridgeHtml: () => string;
  };

  const html = bridgeModule.renderProjectWikiDashboardBridgeHtml();
  assert.match(html, /ProjectWiki has replaced the direct memory dashboard/);
  assert.match(html, /localStorage\.setItem\('activeTab', 'memory'\)/);
  assert.ok(html.includes("window.location.replace('/');"));
});

test("ProjectWiki dashboard resolves real project names and rejects general chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-project-name-root-"));
  const previousConfigPath = process.env.PILOTDECK_CONFIG_PATH;
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOTDECK_CONFIG_PATH = join(root, "missing-pilotdeck.yaml");
    const pilotHome = join(root, "pilot-home");
    process.env.PILOT_HOME = pilotHome;
    const projectRoot = join(root, "workspace", "demo");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(pilotHome, "projects", "demo-project"), { recursive: true });
    await writeFile(join(pilotHome, "projects", "demo-project", ".cwd"), projectRoot, "utf8");
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ projectPath: string; rootDir: string }>;
    };
    const pathsModule = await import(pathToFileURL(join(process.cwd(), "ui/server/utils/pilotPaths.js")).href) as {
      getPilotProjectWikiRootDir: (projectPath: string, pilotHome?: string) => string;
    };

    const resolved = await serviceModule.resolveProjectWikiRoot("demo-project");
    assert.equal(resolved.projectPath, projectRoot);
    assert.equal(resolved.rootDir, pathsModule.getPilotProjectWikiRootDir(projectRoot, pilotHome));
    await assert.rejects(
      () => serviceModule.resolveProjectWikiRoot("general"),
      /ProjectWiki is not available in general chat/,
    );
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PILOTDECK_CONFIG_PATH;
    } else {
      process.env.PILOTDECK_CONFIG_PATH = previousConfigPath;
    }
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki dashboard resolves the configured rootDir used by runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-config-root-"));
  const configPath = join(root, "pilotdeck.yaml");
  const wikiRoot = join(root, "configured-project-wiki");
  const previousConfigPath = process.env.PILOTDECK_CONFIG_PATH;
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    await writeFile(
      configPath,
      [
        "projectWiki:",
        "  enabled: true",
        `  rootDir: ${JSON.stringify(wikiRoot)}`,
      ].join("\n"),
      "utf8",
    );
    process.env.PILOTDECK_CONFIG_PATH = configPath;
    process.env.PILOT_HOME = join(root, "pilot-home");
    const serviceModule = await import(pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href) as {
      resolveProjectWikiRoot: (projectPath: string) => Promise<{ projectPath: string; rootDir: string }>;
    };
    const pathsModule = await import(pathToFileURL(join(process.cwd(), "ui/server/utils/pilotPaths.js")).href) as {
      resolveProjectStorageId: (projectPath: string, pilotHome?: string) => string;
    };

    const projectRoot = join(root, "project");
    const projectId = pathsModule.resolveProjectStorageId(projectRoot, process.env.PILOT_HOME);
    const resolved = await serviceModule.resolveProjectWikiRoot(projectRoot);
    assert.equal(resolved.rootDir, join(wikiRoot, projectId, "project_wiki"));
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PILOTDECK_CONFIG_PATH;
    } else {
      process.env.PILOTDECK_CONFIG_PATH = previousConfigPath;
    }
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki runtime scopes configured rootDir per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-runtime-root-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const wikiBaseRoot = join(root, "configured-project-wiki");

  try {
    await mkdir(projectRoot, { recursive: true });
    const service = createProjectWikiServiceFromConfig({
      config: {
        ...projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: false }),
        rootDir: wikiBaseRoot,
      },
      modelRuntime: modelRuntimeForSchemas({}),
      agentModel: { provider: "test", model: "model" },
      projectRoot,
      pilotHome,
    });
    assert.ok(service);

    await service.refresh({ reason: "test_root_scoping" });

    const projectId = resolveProjectStorageId(projectRoot, pilotHome);
    const expectedRoot = join(wikiBaseRoot, projectId, "project_wiki");
    const home = await readFile(join(expectedRoot, "home.md"), "utf8");
    assert.match(home, /ProjectWiki/);
    await assert.rejects(
      () => readFile(join(wikiBaseRoot, "home.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki catalog ignores obsolete non-canonical wiki pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-obsolete-page-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    await writeFile(
      join(wikiRoot, "wiki", "collaboration-context.md"),
      [
        "---",
        "type: wiki_page",
        "pageId: collaboration-context",
        "title: Obsolete Collaboration Context",
        "description: A retired page from an older ProjectWiki shape.",
        "updatedAt: 2026-06-25T00:00:00.000Z",
        "---",
        "# Obsolete Collaboration Context",
        "This page should not be offered to the ProjectWiki searcher.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await store.listCatalog(50_000);
    assert.ok(catalog.some((entry) => entry.relativePath === "wiki/project-overview.md"));
    assert.ok(!catalog.some((entry) => entry.relativePath === "wiki/collaboration-context.md"));

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: createToolSearchModelRuntime(),
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });
    assert.equal(await service.read({ relativePath: "wiki/collaboration-context.md" }), undefined);
    assert.ok(await service.read({ relativePath: "wiki/project-overview.md" }));

    const readTool = createProjectWikiTools(service).find((tool) => tool.name === "projectwiki_read");
    assert.ok(readTool);
    await assert.rejects(
      () => readTool.execute({
        relativePath: "wiki/collaboration-context.md",
        maxChars: 1_000,
      }, toolContext(projectRoot)),
      /ProjectWiki file not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki catalog keeps canonical wiki pages visible when source cards exceed the catalog budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-catalog-budget-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Very Large Source Card",
      description: "Large source card ".repeat(700),
      summary: "Large source card body ".repeat(700),
      sourceRefs: [{ kind: "transcript", label: "large-card" }],
    });

    const catalog = await store.listCatalog(4_000);
    const paths = catalog.map((entry) => entry.relativePath);
    assert.deepEqual(paths.slice(0, 4), [
      "wiki/project-overview.md",
      "wiki/project-status.md",
      "wiki/project-feedback.md",
      "wiki/knowledge.md",
    ]);
    assert.ok(paths.every((path) => !path.includes("very-large-source-card")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki searcher receives the full model catalog when the compact catalog is truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-full-catalog-search-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let modelCatalogPaths: string[] = [];

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const relevant = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Rare Needle Runbook",
      description: "The only card that mentions the rare needle deployment runbook.",
      summary: "Use the blue-green deployment runbook when the rare needle release flag is enabled.",
      tags: ["rare-needle"],
      confidence: 0.94,
      evidenceLevel: "high",
      sourceRefs: [{ kind: "transcript", label: "rare needle decision" }],
    });

    const compactCatalog = await store.listCatalog(900);
    assert.ok(!compactCatalog.some((entry) => entry.relativePath === relevant.relativePath));

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            const schemaName = request.outputSchema?.name ?? "";
            if (schemaName === "project_wiki_tool_search") {
              const first = request.messages[0]?.content[0];
              const prompt = JSON.parse(first?.type === "text" ? first.text : "{}") as {
                catalog?: Array<{ relativePath?: string }>;
              };
              modelCatalogPaths = (prompt.catalog ?? []).map((entry) => entry.relativePath ?? "");
              assert.ok(modelCatalogPaths.includes(relevant.relativePath));
              return jsonResponse({
                needsProjectWiki: true,
                intent: "Find the rare needle runbook.",
                selected: [{
                  relativePath: relevant.relativePath,
                  reason: "Full ProjectWiki catalog exposed the matching source card to the Searcher model.",
                  priority: 10,
                }],
                rejected: [],
              });
            }
            throw new Error(`Unexpected schema ${schemaName}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "model" },
        timeoutMs: 1_000,
      }),
      config: {
        ...projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
        limits: {
          ...projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }).limits,
          maxCatalogChars: 900,
          maxSourceCardsPerTurn: 4,
        },
      },
    });

    const result = await service.search({
      query: "rare needle runbook",
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      recentMessages: [],
    });

    assert.deepEqual(result.selected.map((entry) => entry.relativePath), [relevant.relativePath]);
    assert.ok(modelCatalogPaths.includes(relevant.relativePath));
    const traces = await store.readTrace("retrieval");
    const searchTrace = traces.find((trace) => trace.phase === "tool_search");
    assert.ok(searchTrace);
    assert.match(JSON.stringify(searchTrace.input), /Rare Needle Runbook/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki searcher receives open conflicts with supporting source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-open-conflict-search-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  let searchPrompt = "";

  try {
    await mkdir(projectRoot, { recursive: true });
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const card = await store.writeSourceCard({
      sourceType: "knowledge",
      title: "Test Stack Decision",
      description: "Conflicting evidence about the test runner.",
      summary: "One source says Jest while another says Vitest.",
      confidence: 0.9,
      evidenceLevel: "high",
    });
    await store.appendConflicts([{
      topic: "Test runner conflict",
      summary: "The current test runner is unresolved between Jest and Vitest.",
      sourceCardIds: [card.id],
    }]);

    const service = new ProjectWikiService({
      projectRoot,
      store,
      modelRunner: new ProjectWikiModelRunner({
        modelRuntime: {
          async *stream() {
            throw new Error("stream should not be called");
          },
          async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
            const schemaName = request.outputSchema?.name ?? "";
            if (schemaName === "project_wiki_tool_search") {
              const first = request.messages[0]?.content[0];
              searchPrompt = first?.type === "text" ? first.text : "";
              return jsonResponse({ needsProjectWiki: false, selected: [], rejected: [] });
            }
            throw new Error(`Unexpected schema ${schemaName}`);
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
        },
        models: {},
        fallbackModel: { provider: "test", model: "mock" },
        timeoutMs: 1_000,
      }),
      config: projectWikiConfig({ repo: false, memory: false, conversations: false, knowledge: true }),
    });

    await service.search({
      query: "Which test runner should I use?",
      sessionId: "session-1",
      turnId: "turn-1",
      projectRoot,
      recentMessages: [],
    });

    const prompt = JSON.parse(searchPrompt) as {
      openConflicts?: Array<{ topic: string; sourceCardIds: string[]; sourcePaths: string[] }>;
    };
    assert.equal(prompt.openConflicts?.[0]?.topic, "Test runner conflict");
    assert.deepEqual(prompt.openConflicts?.[0]?.sourceCardIds, [card.id]);
    assert.deepEqual(prompt.openConflicts?.[0]?.sourcePaths, [card.relativePath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki initialization repairs existing transcript source refs when chat files exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-repair-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");
  const chatDir = join(root, "chats");
  const sessionId = "web:s_repair";
  const transcriptPath = join(chatDir, `${sessionId}.jsonl`);

  try {
    await mkdir(chatDir, { recursive: true });
    await writeFile(transcriptPath, "{\"type\":\"user\"}\n", "utf8");
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const card = await store.writeSourceCard({
      sourceType: "conversations",
      title: "Legacy Card",
      description: "A legacy source card without transcript paths.",
      summary: "Legacy summary.",
      sourceRefs: [{
        kind: "transcript",
        label: "legacy transcript ref",
        sessionId,
        turnId: "turn-1",
        messageId: "Message 1",
      }],
    });

    let before = await readFile(join(wikiRoot, card.relativePath), "utf8");
    assert.doesNotMatch(before, /path=/);
    assert.doesNotMatch(before, /"path":/);

    await store.ensureInitialized();

    const after = await readFile(join(wikiRoot, card.relativePath), "utf8");
    assert.match(after, new RegExp(`"path":"${escapeRegExp(transcriptPath)}"`));
    assert.match(after, new RegExp(`path=${escapeRegExp(transcriptPath)}`));
    assert.match(after, /Legacy summary\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki initialization marks source cards stale when refs do not support their source type", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-source-type-health-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    const card = await store.writeSourceCard({
      sourceType: "repo",
      title: "Conversation Backed Repo Card",
      description: "A repo card produced by an older indexer from transcript-only evidence.",
      summary: "This card looks like repo knowledge but only links to a transcript.",
      sourceRefs: [{
        kind: "transcript",
        label: "older run",
        sessionId: "session-1",
        turnId: "turn-1",
      }],
    });

    await store.ensureInitialized();

    const after = await readFile(join(wikiRoot, card.relativePath), "utf8");
    assert.match(after, /sourceType: "repo"/);
    assert.match(after, /status: "stale"/);
    assert.match(after, /Repo source card is not backed by repository source refs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectWiki initialization repairs source card sourceType to match its canonical directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-wiki-source-type-repair-"));
  const projectRoot = join(root, "project");
  const wikiRoot = join(root, "project_wiki");

  try {
    const store = new ProjectWikiStore({ rootDir: wikiRoot, projectRoot });
    await store.ensureInitialized();
    const cardPath = join(wikiRoot, "source_cards", "repo", "sc_mismatch.md");
    await writeFile(
      cardPath,
      [
        "---",
        "id: \"sc_mismatch\"",
        "type: \"source_card\"",
        "sourceType: \"knowledge\"",
        "title: \"Repo Directory Card\"",
        "description: \"A card whose frontmatter drifted from its directory.\"",
        "tags: []",
        "status: \"active\"",
        "importance: 0",
        "createdAt: \"2026-06-25T00:00:00.000Z\"",
        "updatedAt: \"2026-06-25T00:00:00.000Z\"",
        "sourceRefs:",
        "  - {\"kind\":\"repo_file\",\"label\":\"package.json\",\"path\":\"/tmp/package.json\"}",
        "---",
        "",
        "# Repo Directory Card",
        "",
        "> A card whose frontmatter drifted from its directory.",
        "",
        "## Summary",
        "The sourceType should follow the canonical source_cards/repo directory.",
        "",
        "## Source References",
        "- repo_file | package.json | path=/tmp/package.json",
      ].join("\n"),
      "utf8",
    );

    await store.ensureInitialized();

    const after = await readFile(cardPath, "utf8");
    assert.match(after, /sourceType: "repo"/);
    assert.doesNotMatch(after, /sourceType: "knowledge"/);
    assert.match(after, /status: "active"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createSourceRefModelRuntime(): ModelRuntime {
  return {
    async *stream() {
      throw new Error("stream should not be called");
    },
    async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      if (request.outputSchema?.name === "project_wiki_index") {
        return jsonResponse({
          cards: [{
            sourceType: "conversations",
            title: "Durable Project Fact",
            description: "A model-created card with an incomplete source ref.",
            summary: "The durable fact is now known.",
            sourceRefs: [{
              kind: "transcript",
              label: "model supplied transcript ref",
              sessionId: "session-1",
              turnId: "turn-1",
              messageId: "Message 2",
              excerpt: "durable fact",
              range: { messageIndex: 2 },
            }],
          }],
        });
      }
      if (request.outputSchema?.name === "project_wiki_maintain") {
        return jsonResponse({ pages: [] });
      }
      throw new Error(`Unexpected schema ${request.outputSchema?.name ?? "none"}`);
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

function transcriptEntry<T extends Record<string, unknown>>(entry: T): T & {
  entryId: string;
  parentEntryId: null;
} {
  return {
    ...entry,
    entryId: `${entry.type ?? "entry"}-${entry.sequence ?? "0"}`,
    parentEntryId: null,
  };
}

function turnResult(sessionId: string, turnId: string, startedAt: string, completedAt: string) {
  return {
    type: "success",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt,
    completedAt,
    finalMessage: {
      role: "assistant",
      content: [{ type: "text", text: `Completed ${turnId}` }],
    },
    sessionId,
    turnId,
  };
}

function createToolSearchModelRuntime(): ModelRuntime {
  return modelRuntimeForSchemas({
    project_wiki_tool_search: {
      selected: [{
        relativePath: "wiki/knowledge.md",
        reason: "Contains the testing stack summary.",
        priority: 1,
      }],
      rejected: [],
      intent: "Find testing stack.",
    },
  });
}

function createRepoIndexModelRuntime(): ModelRuntime {
  let count = 0;
  return modelRuntimeForSchemas({
    project_wiki_repo_index: () => {
      count += 1;
      return {
        cards: [{
          sourceType: "repo",
          title: `Repo Snapshot ${count}`,
          description: "Repository digest summary.",
          summary: `Repository snapshot ${count}.`,
        }],
      };
    },
    project_wiki_maintain: { pages: [] },
  });
}

function createRepoDigestCaptureModelRuntime(onDigest: (digest: string) => void): ModelRuntime {
  return {
    async *stream() {
      throw new Error("stream should not be called");
    },
    async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      if (request.outputSchema?.name === "project_wiki_repo_index") {
        const text = request.messages[0]?.content[0]?.type === "text"
          ? request.messages[0].content[0].text
          : "{}";
        const parsed = JSON.parse(text) as { digest?: string };
        onDigest(parsed.digest ?? "");
        return jsonResponse({
          cards: [{
            sourceType: "repo",
            title: "Repo Source Digest",
            description: "Repository digest summary.",
            summary: "Repository digest captured nested source files.",
          }],
        });
      }
      if (request.outputSchema?.name === "project_wiki_maintain") {
        return jsonResponse({ pages: [] });
      }
      throw new Error(`Unexpected schema ${request.outputSchema?.name ?? "none"}`);
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

function createConflictModelRuntime(): ModelRuntime {
  return modelRuntimeForSchemas({
    project_wiki_index: {
      cards: [{
        sourceType: "conversations",
        title: "Conversation Fact",
        description: "A conversation fact.",
        summary: "The test stack may be Jest or Vitest.",
      }],
    },
    project_wiki_maintain: {
      pages: [],
      conflicts: [{
        topic: "Conflicting test stack",
        summary: "One source says Jest while another suggests Vitest.",
        sourceCardIds: ["sc_test"],
      }],
    },
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readDirectoryEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshnessDigest(messages: CanonicalMessage[], maxChars: number): string {
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
  const text = lines.join("\n\n");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function projectWikiConfig(sources: {
  repo: boolean;
  memory: boolean;
  conversations: boolean;
  knowledge: boolean;
}) {
  return {
    enabled: true,
    language: "en" as const,
    models: {},
    sources,
    limits: {
      maxContextChars: 12_000,
      maxSourceCardsPerTurn: 12,
      maxCatalogChars: 24_000,
      maxMaterialChars: 8_000,
      modelTimeoutMs: 1_000,
    },
  };
}

function captureInput(projectRoot: string, turnId: string) {
  return {
    sessionId: "session-1",
    turnId,
    projectRoot,
    errored: false,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Remember this project fact." }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "A durable project fact." }],
      },
    ],
  };
}

async function writeTranscriptForCapture(root: string, projectRoot: string, turnId: string): Promise<string> {
  const input = captureInput(projectRoot, turnId);
  const transcriptPath = join(root, `${turnId}.jsonl`);
  const userMessage = input.messages[0]!;
  const assistantMessage = input.messages[1]!;
  await writeFile(transcriptPath, [
    JSON.stringify(transcriptEntry({
      type: "accepted_input",
      sessionId: input.sessionId,
      turnId,
      sequence: 1,
      createdAt: "2026-06-20T00:00:00.000Z",
      messages: [userMessage],
    })),
    JSON.stringify(transcriptEntry({
      type: "assistant_message",
      sessionId: input.sessionId,
      turnId,
      sequence: 2,
      createdAt: "2026-06-20T00:00:01.000Z",
      message: assistantMessage,
    })),
    "",
  ].join("\n"), "utf8");
  return transcriptPath;
}

function toolContext(cwd: string) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: {},
  } as any;
}

function jsonResponse(value: unknown): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(value) }],
    finishReason: "stop",
  };
}

function toolCallResponse(name: string, input: unknown, id: string): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, input }],
    finishReason: "tool_call",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
