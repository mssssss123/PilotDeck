/**
 * Unified session messages endpoint (PilotDeck-only).
 *
 * GET /api/sessions/:sessionId/messages?projectName=&projectPath=&limit=&offset=
 *
 * Reads transcripts through the gateway's `readSessionMessages` RPC.
 * Previously this route imported `readWebSessionMessages` directly from
 * `dist/src/web/server/` — that coupled `ui/server/` to compiled
 * artifacts and meant `src/` edits were silently invisible until a
 * `npm run build`. Going through the gateway WebSocket means the
 * standalone `pilotdeck server` process owns the read path and we pick
 * up its in-flight session writes automatically.
 *
 * @module routes/messages
 */

import express from 'express';
import fs from 'fs/promises';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { createNormalizedMessage } from '../pilotdeck-message.js';
import { resolveProjectWikiRoot } from '../services/projectWikiService.js';

const router = express.Router();
const REPO_ROOT = process.cwd();
const PROJECT_WIKI_HISTORY_TRACE_LIMIT = 240;

router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const projectPath = String(req.query.projectPath || req.query.projectName || REPO_ROOT);
    const limitParam = req.query.limit;
    const limit = limitParam !== undefined && limitParam !== null && limitParam !== ''
      ? parseInt(limitParam, 10)
      : null;
    const offset = parseInt(req.query.offset || '0', 10);

    const gateway = await getPilotDeckGateway();
    const result = await gateway.readSessionMessages({
      sessionKey: sessionId,
      projectKey: projectPath,
      limit: limit ?? undefined,
      cursor: offset > 0 ? String(offset) : undefined,
    });

    const baseMessages = result.messages.map((message) => mapWebMessageToNormalized(message, sessionId));
    const projectWikiFrames = limit === null
      ? await loadProjectWikiHistoryFrames({ sessionId, projectPath, provider: 'pilotdeck' })
      : [];
    const messages = mergeHistoryMessages(baseMessages, projectWikiFrames);
    const totalKnown = limit === null
      ? messages.length
      : (typeof result.total === 'number' ? result.total : messages.length + offset);
    const hasMore = result.nextCursor !== undefined && result.nextCursor !== null;

    return res.json({
      messages,
      total: totalKnown,
      hasMore,
      offset,
      limit,
    });
  } catch (error) {
    console.error('[messages] read_session_messages failed:', error);
    return res.json({ messages: [], total: 0, hasMore: false, offset: 0, limit: null });
  }
});

router.get('/:sessionId/subagent/:subagentId/messages', async (req, res) => {
  try {
    const { sessionId, subagentId } = req.params;
    const projectPath = String(req.query.projectPath || req.query.projectName || REPO_ROOT);

    const gateway = await getPilotDeckGateway();
    const result = await gateway.readSubagentMessages({
      sessionKey: sessionId,
      subagentId,
      projectKey: projectPath,
    });

    const messages = result.messages.map((message) =>
      mapWebMessageToNormalized(message, `${sessionId}::sub::${subagentId}`)
    );

    return res.json({
      messages,
      total: result.total,
      hasMore: false,
    });
  } catch (error) {
    console.error('[messages] read_subagent_messages failed:', error);
    return res.json({ messages: [], total: 0, hasMore: false });
  }
});

function mapWebMessageToNormalized(message, sessionId) {
  const base = {
    id: message.id,
    sessionId,
    timestamp: message.createdAt,
    provider: message.provider || 'pilotdeck',
  };
  switch (message.kind) {
    case 'text':
      return createNormalizedMessage({
        ...base,
        kind: 'text',
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.text || '',
        ...(Array.isArray(message.images) && message.images.length > 0
          ? { images: message.images.map((image) => image?.data).filter(Boolean) }
          : {}),
      });
    case 'thinking':
      return createNormalizedMessage({ ...base, kind: 'thinking', content: message.text || '' });
    case 'tool_use':
      return createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: message.toolName,
        toolInput: message.payload,
        toolId: message.toolCallId,
        ...(message.subagentId ? { subagentId: message.subagentId } : {}),
      });
    case 'tool_result': {
      const planPayload = message.payload && typeof message.payload === 'object'
          ? message.payload
          : {};
      return createNormalizedMessage({
        ...base,
        kind: 'tool_result',
        toolId: message.toolCallId,
        content: message.text || '',
        isError: message.ok === false,
        ...(message.errorCode ? { errorCode: message.errorCode } : {}),
        // Inline tool-result images (e.g. read_file on a PNG). The web
        // server already wraps the bare base64 from canonical messages as
        // data URLs in `toWebMessageImage`, so just pass them through.
        ...(Array.isArray(message.images) && message.images.length > 0
          ? {
              toolResultImages: message.images
                .filter((image) => image && typeof image.data === 'string')
                .map((image) => ({ data: image.data, mimeType: image.mimeType })),
            }
          : {}),
        ...(planPayload.planFilePath ? {
            planFilePath: planPayload.planFilePath,
            planTitle: planPayload.planTitle,
            planSummary: planPayload.planSummary,
        } : {}),
      });
    }
    case 'permission_request':
      return createNormalizedMessage({
        ...base,
        kind: 'permission_request',
        requestId: message.requestId,
        toolName: message.toolName,
        input: message.payload,
      });
    case 'elicitation_request':
      return createNormalizedMessage({
        ...base,
        kind: 'interactive_prompt',
        requestId: message.requestId,
        content: '',
      });
    case 'structured_output':
      return createNormalizedMessage({
        ...base,
        kind: 'status',
        text: 'structured',
        payload: message.payload,
      });
    case 'status':
      return createNormalizedMessage({ ...base, kind: 'status', text: message.text || '' });
    case 'complete':
      return createNormalizedMessage({ ...base, kind: 'complete' });
    case 'error':
      return createNormalizedMessage({ ...base, kind: 'error', content: message.text || '' });
    case 'interrupted':
      return createNormalizedMessage({ ...base, kind: 'interrupted', content: message.text || '' });
    case 'compact_boundary': {
      const payload = message.payload || {};
      return createNormalizedMessage({
        ...base,
        kind: 'compact_boundary',
        trigger: payload.trigger || 'auto',
        preTokens: payload.preTokens,
        compactLevel: payload.level,
        compactStage: payload.stage,
        compactStageLabel: payload.stageLabel || payload.stage,
        compactMetadata: payload,
      });
    }
    default:
      return createNormalizedMessage({ ...base, kind: 'status', text: message.kind });
  }
}

async function loadProjectWikiHistoryFrames({ sessionId, projectPath, provider }) {
  try {
    const { rootDir } = await resolveProjectWikiRoot(projectPath);
    const [retrieval, context] = await Promise.all([
      readProjectWikiTraceFile(rootDir, 'retrieval', PROJECT_WIKI_HISTORY_TRACE_LIMIT),
      readProjectWikiTraceFile(rootDir, 'context', PROJECT_WIKI_HISTORY_TRACE_LIMIT),
    ]);
    const traces = [...retrieval, ...context]
      .filter((trace) => trace?.sessionId === sessionId)
      .filter((trace) => trace?.pipelineKind === 'retrieval_context')
      .filter((trace) => typeof trace.pipelineRunId === 'string' && trace.pipelineRunId);

    const byPipeline = new Map();
    for (const trace of traces) {
      const key = trace.pipelineRunId;
      if (!byPipeline.has(key)) byPipeline.set(key, []);
      byPipeline.get(key).push(trace);
    }

    return [...byPipeline.entries()]
      .map(([pipelineRunId, group]) => buildProjectWikiHistoryFrame({
        sessionId,
        provider,
        pipelineRunId,
        traces: group,
      }))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readProjectWikiTraceFile(rootDir, kind, limit) {
  try {
    const content = await fs.readFile(`${rootDir}/traces/${kind}-runs.jsonl`, 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildProjectWikiHistoryFrame({ sessionId, provider, pipelineRunId, traces }) {
  const sorted = [...traces].sort(compareProjectWikiTrace);
  if (sorted.length === 0) return null;
  const contextTrace = [...sorted].reverse().find((trace) => trace.kind === 'context');
  const retrieverTrace = [...sorted].reverse().find((trace) =>
    trace.kind === 'retrieval' &&
    (Array.isArray(trace.output?.selected) || Array.isArray(trace.output?.rejected))
  );
  const readTrace = [...sorted].reverse().find((trace) =>
    trace.kind === 'retrieval' &&
    Array.isArray(trace.output?.materials)
  );

  const catalog = extractProjectWikiCatalog(sorted);
  const materialByPath = new Map(catalog.map((material) => [material.relativePath, material]));
  const read = uniqueMaterials(
    extractProjectWikiMaterials(readTrace?.output?.materials ?? contextTrace?.input?.materials)
      .map((material) => mergeProjectWikiMaterial(materialByPath.get(material.relativePath), material)),
  );
  for (const material of read) {
    materialByPath.set(material.relativePath, mergeProjectWikiMaterial(materialByPath.get(material.relativePath), material));
  }

  const selected = uniqueMaterials(
    extractProjectWikiMaterials(contextTrace?.input?.selected ?? retrieverTrace?.output?.selected)
      .map((material) => mergeProjectWikiMaterial(materialByPath.get(material.relativePath), material)),
  );
  const rejected = uniqueMaterials(
    extractProjectWikiMaterials(retrieverTrace?.output?.rejected)
      .map((material) => mergeProjectWikiMaterial(materialByPath.get(material.relativePath), material)),
  );
  const contextPreview = readProjectWikiPreview(contextTrace?.output?.context);
  const hasUsablePayload =
    catalog.length > 0 ||
    selected.length > 0 ||
    read.length > 0 ||
    rejected.length > 0 ||
    Boolean(contextPreview) ||
    sorted.some((trace) => trace.status === 'error');
  if (!hasUsablePayload) return null;

  const finalTrace = contextTrace ?? sorted[sorted.length - 1];
  const failed = finalTrace?.status === 'error';
  const skipped = !failed && (finalTrace?.status === 'skipped' || retrieverTrace?.output?.needsProjectWiki === false);
  const state = failed ? 'failed' : skipped ? 'skipped' : 'completed';
  const startedAt = sorted[0].createdAt || new Date().toISOString();
  const endedAt = sorted[sorted.length - 1].createdAt || startedAt;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || sumProjectWikiDurations(sorted);
  const contextSectionCount = countProjectWikiContextSections(contextPreview);

  return createNormalizedMessage({
    id: `project_wiki_activity_${sanitizeMessageId(sessionId)}_${sanitizeMessageId(pipelineRunId)}`,
    sessionId,
    provider,
    timestamp: startedAt,
    kind: 'agent_activity',
    activityId: `project-wiki:${pipelineRunId}`,
    runId: `project-wiki:${pipelineRunId}`,
    turnId: sorted.find((trace) => trace.turnId)?.turnId || null,
    phase: 'project_wiki',
    state,
    title: 'ProjectWiki',
    detail: makeProjectWikiHistoryDetail({ state, selectedCount: selected.length, readCount: read.length, contextSectionCount }),
    startedAt,
    endedAt,
    durationMs,
    severity: failed ? 'error' : undefined,
    projectWiki: {
      phase: failed ? 'failed' : skipped ? 'skipped' : 'assembled',
      query: sorted.find((trace) => typeof trace.input?.query === 'string')?.input?.query,
      pipelineRunId,
      projectRoot: sorted.find((trace) => typeof trace.projectRoot === 'string')?.projectRoot,
      catalog,
      selected,
      rejected,
      read,
      contextPreview,
      contextSections: contextSectionCount > 0 ? [{ title: 'ProjectWiki Summary' }] : [],
      stats: {
        catalogCount: catalog.length,
        selectedCount: selected.length,
        rejectedCount: rejected.length,
        readCount: read.length,
        contextSectionCount,
      },
      error: sorted.find((trace) => trace.error)?.error,
      events: sorted.slice(-8).map(projectWikiTraceToEvent),
    },
  });
}

function mergeHistoryMessages(messages, injected) {
  if (!Array.isArray(injected) || injected.length === 0) return messages;
  const existingIds = new Set(messages.map((message) => message.id));
  const additions = injected.filter((message) => !existingIds.has(message.id));
  if (additions.length === 0) return messages;
  return [...messages, ...additions]
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const delta = parseMessageTimestamp(a.message.timestamp) - parseMessageTimestamp(b.message.timestamp);
      return delta || a.index - b.index;
    })
    .map((entry) => entry.message);
}

function compareProjectWikiTrace(a, b) {
  const stepDelta = readNumber(a.stepIndex, Number.MAX_SAFE_INTEGER) - readNumber(b.stepIndex, Number.MAX_SAFE_INTEGER);
  if (stepDelta !== 0) return stepDelta;
  return parseMessageTimestamp(a.createdAt) - parseMessageTimestamp(b.createdAt);
}

function extractProjectWikiCatalog(traces) {
  const materials = [];
  for (const trace of traces) {
    materials.push(...extractProjectWikiMaterials(trace.input?.catalog));
    materials.push(...extractProjectWikiMaterials(trace.output?.catalog));
  }
  return uniqueMaterials(materials);
}

function extractProjectWikiMaterials(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(projectWikiMaterialFromUnknown)
    .filter((material) => material?.relativePath);
}

function projectWikiMaterialFromUnknown(value) {
  if (!value || typeof value !== 'object') return null;
  const frontmatter = value.frontmatter && typeof value.frontmatter === 'object' ? value.frontmatter : {};
  const catalog = value.catalog && typeof value.catalog === 'object' ? value.catalog : {};
  const relativePath = readString(value.relativePath) || readString(catalog.relativePath);
  if (!relativePath) return null;
  return {
    relativePath,
    title: readString(value.title) || readString(catalog.title) || readString(frontmatter.title),
    description: readString(value.description) || readString(catalog.description) || readString(frontmatter.description),
    kind: normalizeProjectWikiMaterialKind(readString(value.kind) || readString(catalog.kind) || readString(frontmatter.type), relativePath),
    sourceType: readString(value.sourceType) || readString(catalog.sourceType) || readString(frontmatter.sourceType),
    status: readString(value.status) || readString(catalog.status) || readString(frontmatter.status),
    reason: readString(value.reason),
    priority: typeof value.priority === 'number' ? value.priority : undefined,
    preview: readProjectWikiPreview(value.preview) || readProjectWikiPreview(catalog.preview) || readProjectWikiPreview(value.content),
  };
}

function mergeProjectWikiMaterial(base, next) {
  if (!base) return next;
  return {
    ...base,
    ...next,
    title: next.title || base.title,
    description: next.description || base.description,
    kind: next.kind || base.kind,
    sourceType: next.sourceType || base.sourceType,
    status: next.status || base.status,
    reason: next.reason || base.reason,
    priority: next.priority ?? base.priority,
    preview: next.preview || base.preview,
  };
}

function uniqueMaterials(materials) {
  const byPath = new Map();
  for (const material of materials) {
    if (!material?.relativePath) continue;
    byPath.set(material.relativePath, mergeProjectWikiMaterial(byPath.get(material.relativePath), material));
  }
  return [...byPath.values()];
}

function normalizeProjectWikiMaterialKind(kind, relativePath) {
  if (relativePath === 'home.md') return 'home';
  if (relativePath.startsWith('wiki/')) return 'wiki';
  if (relativePath.startsWith('source_cards/')) return 'source_card';
  if (kind === 'home' || kind === 'wiki' || kind === 'source_card' || kind === 'context') return kind;
  return undefined;
}

function projectWikiTraceToEvent(trace, index) {
  const state = trace.status === 'error' ? 'failed' : trace.status === 'skipped' ? 'skipped' : 'completed';
  return {
    id: trace.id || `pw-history-${index}`,
    at: trace.createdAt,
    phase: trace.phase,
    state,
    title: projectWikiTraceTitle(trace),
    detail: projectWikiTraceDetail(trace),
    selectedCount: Array.isArray(trace.output?.selected) ? trace.output.selected.length : undefined,
    rejectedCount: Array.isArray(trace.output?.rejected) ? trace.output.rejected.length : undefined,
    readCount: Array.isArray(trace.output?.materials) ? trace.output.materials.length : undefined,
  };
}

function projectWikiTraceTitle(trace) {
  if (trace.kind === 'context') return 'ProjectWiki 已组装本轮上下文';
  if (trace.phase === 'read') return 'ProjectWiki 正在读取选中材料';
  if (trace.phase === 'retriever_tool_call') return 'Retriever 生成工具调用';
  if (trace.phase === 'retriever_fallback') return 'Retriever fallback';
  if (trace.phase === 'search') return '检索决策';
  return trace.stepName || trace.phase || 'ProjectWiki';
}

function projectWikiTraceDetail(trace) {
  if (trace.error) return trace.error;
  const notes = readString(trace.output?.notes);
  if (notes) return notes;
  const query = readString(trace.input?.query);
  if (query) return query;
  const context = readProjectWikiPreview(trace.output?.context);
  if (context) return context;
  return '';
}

function makeProjectWikiHistoryDetail({ state, selectedCount, readCount, contextSectionCount }) {
  if (state === 'failed') return 'ProjectWiki 准备失败。';
  if (state === 'skipped') return '本轮不需要 ProjectWiki 上下文。';
  if (contextSectionCount > 0) return `ProjectWiki 已组装 ${contextSectionCount} 段上下文。`;
  return `ProjectWiki 选中 ${selectedCount} 个材料，读取 ${readCount} 个材料。`;
}

function countProjectWikiContextSections(text) {
  if (!text) return 0;
  const matches = text.match(/^##\s+/gm);
  return matches ? matches.length : 1;
}

function sumProjectWikiDurations(traces) {
  return traces.reduce((sum, trace) => sum + readNumber(trace.durationMs, 0), 0);
}

function readProjectWikiPreview(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.preview === 'string') return value.preview;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseMessageTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeMessageId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

export default router;
