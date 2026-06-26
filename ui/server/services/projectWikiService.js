import fs from 'fs/promises';
import path from 'path';
import { expandTilde, readPilotDeckConfigFile } from './pilotdeckConfig.js';
import {
  getPilotProjectWikiRootDir,
  resolvePilotHome,
  resolveProjectStorageId,
} from '../utils/pilotPaths.js';

const WIKI_PAGE_ORDER = [
  'project-overview',
  'project-status',
  'project-feedback',
  'knowledge',
];

const SOURCE_TYPES = ['repo', 'memory', 'conversations', 'knowledge'];
const TRACE_KINDS = ['index', 'maintain', 'retrieval', 'context'];
const TRACE_PREVIEW_CHARS = 1200;
const TRACE_FIELD_PREVIEW_CHARS = 700;
const TRACE_ARRAY_LIMIT = 40;

async function normalizeProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('projectPath is required');
  }
  const trimmed = projectPath.trim();
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(await resolveProjectName(trimmed));
}

async function resolveProjectName(projectName) {
  const pilotHome = resolvePilotHome();
  if (!projectName || projectName === 'general') {
    return pilotHome;
  }
  try {
    const marker = await fs.readFile(path.join(pilotHome, 'projects', projectName, '.cwd'), 'utf8');
    const cwd = marker.trim();
    if (cwd) return cwd;
  } catch {
    // Fall through to legacy project id decoding.
  }
  if (projectName.startsWith('-')) {
    return `/${projectName.replace(/^-+/, '').replace(/-/g, '/')}`;
  }
  return pilotHome;
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, parsed));
}

function safeResolve(rootDir, relativePath) {
  const target = path.resolve(rootDir, relativePath);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (target !== rootDir && !target.startsWith(rootWithSep)) {
    throw new Error('Path escapes ProjectWiki root');
  }
  return target;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProjectWikiRoot(projectPath) {
  const normalized = await normalizeProjectPath(projectPath);
  const pilotHome = resolvePilotHome();
  const configuredRoot = resolveConfiguredProjectWikiRoot(normalized, pilotHome);
  return {
    projectPath: normalized,
    rootDir: configuredRoot ?? getPilotProjectWikiRootDir(normalized, pilotHome),
  };
}

function resolveConfiguredProjectWikiRoot(projectPath, pilotHome) {
  try {
    const config = readPilotDeckConfigFile().config;
    const rootDir = typeof config?.projectWiki?.rootDir === 'string'
      ? config.projectWiki.rootDir.trim()
      : '';
    if (!rootDir) return null;
    const defaultRoot = getPilotProjectWikiRootDir(projectPath, pilotHome);
    const configured = path.resolve(expandTilde(rootDir));
    if (configured === path.resolve(defaultRoot)) return configured;
    const projectId = resolveProjectStorageId(projectPath, pilotHome);
    if (configured.includes('{projectId}') || configured.includes('<projectId>')) {
      return configured
        .replaceAll('{projectId}', projectId)
        .replaceAll('<projectId>', projectId);
    }
    if (configured.includes('{project}') || configured.includes('<project>')) {
      return configured
        .replaceAll('{project}', projectId)
        .replaceAll('<project>', projectId);
    }
    return path.resolve(configured, projectId, 'project_wiki');
  } catch {
    return null;
  }
}

export async function readProjectWikiSnapshot(projectPath, options = {}) {
  const { projectPath: normalizedProjectPath, rootDir } = await resolveProjectWikiRoot(projectPath);
  const traceLimit = parseLimit(options.traceLimit, 100);
  const exists = await pathExists(rootDir);
  const [home, wikiPages, sourceCards, rawTraces, conflicts, maintenance] = await Promise.all([
    readMarkdownFile(rootDir, 'home.md'),
    readWikiPages(rootDir),
    readSourceCards(rootDir),
    readTraces(rootDir, traceLimit),
    readConflicts(rootDir, traceLimit),
    readMaintenanceQueue(rootDir, traceLimit),
  ]);
  const wikiPagesWithHealth = attachSourceHealthToWikiPages(wikiPages, sourceCards);
  const traces = normalizeSnapshotTraceArtifacts(rawTraces, { home, wikiPages: wikiPagesWithHealth, sourceCards });
  const refinedWikiPages = wikiPagesWithHealth.filter((page) => !page.isPlaceholder).length;
  const stats = {
    wikiPages: wikiPagesWithHealth.length,
    refinedWikiPages,
    placeholderWikiPages: wikiPagesWithHealth.length - refinedWikiPages,
    sourceCards: sourceCards.length,
    staleSourceCards: sourceCards.filter((card) => card.frontmatter?.status === 'stale').length,
    conflictedSourceCards: sourceCards.filter((card) => card.frontmatter?.status === 'conflict').length,
    staleWikiPages: wikiPagesWithHealth.filter((page) => page.sourceHealth?.stale > 0).length,
    pendingMaintenanceCards: maintenance.pending.length,
    processedMaintenanceCards: maintenance.processed.length,
    traces: Object.values(traces).reduce((sum, rows) => sum + rows.length, 0),
    conflicts: conflicts.length,
    openConflicts: conflicts.filter((conflict) => conflict.status !== 'resolved').length,
    sourceCardsByType: SOURCE_TYPES.reduce((acc, type) => {
      acc[type] = sourceCards.filter((card) => card.sourceType === type).length;
      return acc;
    }, {}),
  };
  return {
    projectPath: normalizedProjectPath,
    rootDir,
    exists,
    home,
    wikiPages: wikiPagesWithHealth,
    sourceCards,
    conflicts,
    maintenance,
    traces,
    stats,
  };
}

function attachSourceHealthToWikiPages(wikiPages, sourceCards) {
  const sourceCardsById = new Map();
  for (const card of sourceCards) {
    const id = typeof card.frontmatter?.id === 'string' ? card.frontmatter.id : '';
    if (!id) continue;
    sourceCardsById.set(id, {
      id,
      title: card.title,
      relativePath: card.relativePath,
      status: typeof card.frontmatter?.status === 'string' ? card.frontmatter.status : 'active',
      statusReason: typeof card.frontmatter?.statusReason === 'string' ? card.frontmatter.statusReason : '',
    });
  }
  return wikiPages.map((page) => {
    const sourceCardIds = Array.isArray(page.frontmatter?.sourceCardIds)
      ? page.frontmatter.sourceCardIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    if (sourceCardIds.length === 0) return page;
    return {
      ...page,
      sourceHealth: computeSourceHealth(sourceCardIds, sourceCardsById),
    };
  });
}

function computeSourceHealth(sourceCardIds, sourceCardsById) {
  const health = {
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
    if (card.status === 'stale') {
      health.stale += 1;
      health.warnings.push(formatSourceHealthWarning(`${card.title} is stale`, card.statusReason));
    } else if (card.status === 'conflict') {
      health.conflict += 1;
      health.warnings.push(formatSourceHealthWarning(`${card.title} is marked conflict`, card.statusReason));
    } else if (card.status === 'draft') {
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

function formatSourceHealthWarning(prefix, reason) {
  if (!reason) return `${prefix}.`;
  const trimmed = String(reason).trim();
  return `${prefix}: ${/[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`}`;
}

export async function readProjectWikiFile(projectPath, relativePath) {
  const { rootDir } = await resolveProjectWikiRoot(projectPath);
  if (!isReadableProjectWikiMarkdownPath(relativePath)) {
    throw new Error('relativePath must be a canonical ProjectWiki markdown path');
  }
  const absolutePath = safeResolve(rootDir, relativePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    relativePath: toPosix(path.relative(rootDir, absolutePath)),
    content,
    frontmatter: parseMarkdown(content).frontmatter,
  };
}

function isReadableProjectWikiMarkdownPath(relativePath) {
  if (typeof relativePath !== 'string') return false;
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized.endsWith('.md')
    || normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.includes('//')
  ) {
    return false;
  }
  if (normalized === 'home.md') return true;
  if (WIKI_PAGE_ORDER.some((pageId) => normalized === `wiki/${pageId}.md`)) return true;
  return SOURCE_TYPES.some((sourceType) => normalized.startsWith(`source_cards/${sourceType}/`));
}

export async function readProjectWikiPayload(projectPath, relativePath) {
  const { rootDir } = await resolveProjectWikiRoot(projectPath);
  if (
    typeof relativePath !== 'string'
    || !relativePath.trim()
    || !relativePath.startsWith('traces/payloads/')
    || !relativePath.endsWith('.json')
  ) {
    throw new Error('relativePath must be a ProjectWiki trace payload path');
  }
  const absolutePath = safeResolve(rootDir, relativePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    relativePath: toPosix(path.relative(rootDir, absolutePath)),
    content,
  };
}

export async function updateProjectWikiConflictStatus(projectPath, conflictId, status) {
  const { rootDir } = await resolveProjectWikiRoot(projectPath);
  const id = typeof conflictId === 'string' ? conflictId.trim() : '';
  if (!id) {
    throw new Error('conflictId is required');
  }
  if (status !== 'open' && status !== 'resolved') {
    throw new Error('status must be "open" or "resolved"');
  }

  const conflicts = await readConflicts(rootDir, 5000);
  const existing = conflicts.find((conflict) => conflict.id === id);
  if (!existing) {
    throw new Error(`ProjectWiki conflict not found: ${id}`);
  }

  const next = {
    ...existing,
    sourceCardIds: Array.isArray(existing.sourceCardIds) ? existing.sourceCardIds : [],
    status,
    updatedAt: new Date().toISOString(),
  };
  const conflictPath = path.join(rootDir, 'conflicts', 'conflicts.jsonl');
  await fs.mkdir(path.dirname(conflictPath), { recursive: true, mode: 0o700 });
  await appendJsonLine(conflictPath, next);
  return next;
}

async function readWikiPages(rootDir) {
  const pages = [];
  for (const pageId of WIKI_PAGE_ORDER) {
    const page = await readMarkdownFile(rootDir, `wiki/${pageId}.md`);
    if (page) pages.push({ ...page, pageId, isPlaceholder: isPlaceholderWikiPage(page) });
  }
  return pages;
}

async function readSourceCards(rootDir) {
  const cards = [];
  for (const sourceType of SOURCE_TYPES) {
    const dir = path.join(rootDir, 'source_cards', sourceType);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relativePath = toPosix(path.join('source_cards', sourceType, entry.name));
      const file = await readMarkdownFile(rootDir, relativePath);
      if (file) cards.push(projectSourceCardSnapshot(file, sourceType));
    }
  }
  return cards;
}

function projectSourceCardSnapshot(file, sourceType) {
  const frontmatter = { ...(file.frontmatter || {}) };
  if (!SOURCE_TYPES.includes(frontmatter.sourceType)) {
    frontmatter.sourceType = sourceType;
  }
  const issue = sourceCardConsistencyIssue(sourceType, normalizeSourceRefs(frontmatter.sourceRefs));
  if (issue && frontmatter.status !== 'conflict' && frontmatter.status !== 'draft') {
    frontmatter.status = 'stale';
    frontmatter.statusReason = frontmatter.statusReason || issue;
  } else if (issue && !frontmatter.statusReason) {
    frontmatter.statusReason = issue;
  }
  return { ...file, sourceType, frontmatter };
}

function sourceCardConsistencyIssue(sourceType, sourceRefs) {
  if (!sourceRefs.length) return '';
  if (
    sourceType === 'repo'
    && !sourceRefs.some((ref) => ref.kind === 'repo' || ref.kind === 'repo_file')
  ) {
    return `Repo source card is not backed by repository source refs; found ${formatSourceRefKinds(sourceRefs)}.`;
  }
  if (
    sourceType === 'memory'
    && !sourceRefs.some((ref) => ref.kind === 'legacy_memory')
  ) {
    return `Memory source card is not backed by imported memory source refs; found ${formatSourceRefKinds(sourceRefs)}.`;
  }
  return '';
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...item,
      kind: typeof item.kind === 'string' ? item.kind : '',
    }))
    .filter((item) => item.kind);
}

function formatSourceRefKinds(sourceRefs) {
  const kinds = [...new Set(sourceRefs.map((ref) => ref.kind).filter(Boolean))];
  return kinds.length > 0 ? kinds.join(', ') : 'unknown refs';
}

async function readMarkdownFile(rootDir, relativePath) {
  const absolutePath = safeResolve(rootDir, relativePath);
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    const parsed = parseMarkdown(content);
    return {
      relativePath: toPosix(relativePath),
      title: parsed.frontmatter.title || inferTitle(parsed.body) || path.basename(relativePath),
      description: parsed.frontmatter.description || '',
      updatedAt: parsed.frontmatter.updatedAt || parsed.frontmatter.createdAt || '',
      content,
      preview: parsed.body.replace(/\s+/g, ' ').trim().slice(0, 360),
      frontmatter: parsed.frontmatter,
    };
  } catch {
    return null;
  }
}

async function readConflicts(rootDir, limit) {
  const conflictPath = path.join(rootDir, 'conflicts', 'conflicts.jsonl');
  let raw;
  try {
    raw = await fs.readFile(conflictPath, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const conflict = JSON.parse(line);
      if (conflict && typeof conflict === 'object' && conflict.id) {
        byId.set(conflict.id, conflict);
      }
    } catch {
      // Ignore malformed conflict rows; the dashboard should show valid trace data.
    }
  }
  return [...byId.values()]
    .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))
    .slice(0, limit)
    .map((conflict) => {
      try {
        return conflict && typeof conflict === 'object' && conflict.id ? conflict : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readMaintenanceQueue(rootDir, limit) {
  const queuePath = path.join(rootDir, 'state', 'wiki-maintenance.jsonl');
  let raw;
  try {
    raw = await fs.readFile(queuePath, 'utf8');
  } catch {
    return {
      pending: [],
      processed: [],
      pendingByType: Object.fromEntries(SOURCE_TYPES.map((type) => [type, 0])),
    };
  }

  const pendingByKey = new Map();
  const processed = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || typeof event.key !== 'string') continue;
    const normalized = normalizeMaintenanceEvent(event);
    if (!normalized) continue;
    if (normalized.op === 'enqueue' && normalized.relativePath) {
      pendingByKey.set(normalized.key, normalized);
    } else if (normalized.op === 'processed') {
      pendingByKey.delete(normalized.key);
      processed.push(normalized);
    }
  }

  const pending = [...pendingByKey.values()]
    .sort((left, right) => String(left.queuedAt ?? '').localeCompare(String(right.queuedAt ?? '')));
  const pendingByType = SOURCE_TYPES.reduce((acc, type) => {
    acc[type] = pending.filter((event) => event.sourceType === type).length;
    return acc;
  }, {});

  return {
    pending: pending.slice(0, limit),
    processed: processed
      .sort((left, right) => String(right.processedAt ?? '').localeCompare(String(left.processedAt ?? '')))
      .slice(0, limit),
    pendingByType,
  };
}

function normalizeMaintenanceEvent(event) {
  const op = event.op === 'enqueue' || event.op === 'processed' ? event.op : undefined;
  if (!op) return null;
  const sourceType = SOURCE_TYPES.includes(event.sourceType) ? event.sourceType : undefined;
  return {
    op,
    key: event.key,
    cardId: typeof event.cardId === 'string' ? event.cardId : undefined,
    relativePath: typeof event.relativePath === 'string' ? event.relativePath : undefined,
    sourceType,
    title: typeof event.title === 'string' ? event.title : undefined,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined,
    turnId: typeof event.turnId === 'string' ? event.turnId : undefined,
    queuedAt: typeof event.queuedAt === 'string' ? event.queuedAt : undefined,
    processedAt: typeof event.processedAt === 'string' ? event.processedAt : undefined,
    traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
  };
}

function renderMarkdown({ frontmatter, title, body }) {
  return [
    '---',
    renderFrontmatter(frontmatter),
    '---',
    '',
    `# ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

async function appendJsonLine(filePath, record) {
  let prefix = '';
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) {
      prefix = '\n';
    }
  } catch {
    // Missing files are expected for the first append.
  }
  await fs.appendFile(filePath, `${prefix}${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function renderFrontmatter(value) {
  return Object.entries(value)
    .map(([key, child]) => renderFrontmatterValue(key, child))
    .join('\n');
}

function renderFrontmatterValue(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return [
      `${key}:`,
      ...value.map((item) => `  - ${JSON.stringify(item)}`),
    ].join('\n');
  }
  if (value && typeof value === 'object') return `${key}: ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`;
  return `${key}: ${JSON.stringify(String(value ?? ''))}`;
}

function isPlaceholderWikiPage(page) {
  if (!page || !page.relativePath?.startsWith('wiki/')) return false;
  const sourceCardIds = page.frontmatter?.sourceCardIds;
  const hasSources = Array.isArray(sourceCardIds) && sourceCardIds.length > 0;
  if (hasSources) return false;
  const body = parseMarkdown(page.content || '').body || '';
  return body.includes('This page has not been refined yet.');
}

async function readTraces(rootDir, limit) {
  const output = {};
  await Promise.all(TRACE_KINDS.map(async (kind) => {
    const tracePath = path.join(rootDir, 'traces', `${kind}-runs.jsonl`);
    let raw;
    try {
      raw = await fs.readFile(tracePath, 'utf8');
    } catch {
      output[kind] = [];
      return;
    }
    output[kind] = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return compactTraceRecord(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  }));
  return output;
}

function compactTraceRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const inputRaw = safeStringify(record.input);
  const outputRaw = safeStringify(record.output);
  const compactedInput = compactTraceValue(record.input);
  const compactedOutput = compactTraceValue(record.output);
  return {
    ...record,
    artifacts: normalizeTraceArtifacts(record.artifacts),
    input: compactedInput,
    output: compactedOutput,
    payload: {
      inputBytes: Buffer.byteLength(inputRaw, 'utf8'),
      outputBytes: Buffer.byteLength(outputRaw, 'utf8'),
      compacted:
        inputRaw !== safeStringify(compactedInput)
        || outputRaw !== safeStringify(compactedOutput)
        || containsCompactedMarker(compactedInput)
        || containsCompactedMarker(compactedOutput),
    },
  };
}

function normalizeTraceArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return artifacts;
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object') return artifact;
    const pathValue = typeof artifact.path === 'string' ? artifact.path : '';
    if (pathValue === 'home.md' || pathValue.startsWith('wiki/')) {
      return { ...artifact, kind: 'wiki_page' };
    }
    if (pathValue.startsWith('source_cards/')) {
      return { ...artifact, kind: 'source_card' };
    }
    if (artifact.kind === 'conflict') {
      return { ...artifact, kind: 'conflict' };
    }
    return artifact;
  });
}

function normalizeSnapshotTraceArtifacts(traces, { home, wikiPages, sourceCards }) {
  const existingPaths = new Set([
    ...(home ? [home.relativePath] : []),
    ...wikiPages.map((page) => page.relativePath),
    ...sourceCards.map((card) => card.relativePath),
  ]);
  const sourcePathById = new Map();
  const sourcePathByBasename = new Map();
  for (const card of sourceCards) {
    const id = typeof card.frontmatter?.id === 'string' ? card.frontmatter.id : '';
    if (id) sourcePathById.set(id, card.relativePath);
    sourcePathByBasename.set(path.basename(card.relativePath), card.relativePath);
  }

  const normalizeArtifact = (artifact) => {
    if (!artifact || typeof artifact !== 'object') return artifact;
    const pathValue = typeof artifact.path === 'string' ? artifact.path : '';
    if (
      pathValue
      && !existingPaths.has(pathValue)
      && (pathValue.startsWith('source_cards/') || artifact.kind === 'source_card')
    ) {
      const id = typeof artifact.id === 'string' ? artifact.id : '';
      const resolvedPath = (id && sourcePathById.get(id)) || sourcePathByBasename.get(path.basename(pathValue));
      if (resolvedPath) {
        return { ...artifact, kind: 'source_card', path: resolvedPath };
      }
    }
    if (pathValue === 'home.md' || pathValue.startsWith('wiki/')) {
      return { ...artifact, kind: 'wiki_page' };
    }
    if (pathValue.startsWith('source_cards/')) {
      return { ...artifact, kind: 'source_card' };
    }
    return artifact;
  };

  const artifactExists = (artifact) => {
    const pathValue = typeof artifact?.path === 'string' ? artifact.path : '';
    return !pathValue || existingPaths.has(pathValue);
  };

  const appendContextSourceArtifacts = (trace, artifacts) => {
    const normalizedArtifacts = Array.isArray(artifacts)
      ? artifacts.map(normalizeArtifact).filter(artifactExists)
      : [];
    const seenPaths = new Set(
      normalizedArtifacts
        .map((artifact) => typeof artifact?.path === 'string' ? artifact.path : '')
        .filter(Boolean),
    );

    for (const sourcePath of extractTraceSourcePaths(trace)) {
      const artifact = normalizeArtifact({ path: sourcePath });
      const pathValue = typeof artifact?.path === 'string' ? artifact.path : '';
      if (!pathValue || seenPaths.has(pathValue) || !artifactExists(artifact)) continue;
      normalizedArtifacts.push(artifact);
      seenPaths.add(pathValue);
    }

    if (normalizedArtifacts.length > 0) return normalizedArtifacts;
    return Array.isArray(artifacts) ? artifacts.map(normalizeArtifact).filter(artifactExists) : artifacts;
  };

  return Object.fromEntries(
    Object.entries(traces).map(([kind, rows]) => [
      kind,
      Array.isArray(rows)
        ? rows.map((trace) => ({
          ...trace,
          artifacts: appendContextSourceArtifacts(trace, trace.artifacts),
        }))
        : rows,
    ]),
  );
}

function extractTraceSourcePaths(trace) {
  if (!trace || trace.kind !== 'context' || !trace.output || typeof trace.output !== 'object') {
    return [];
  }
  const paths = new Set();
  const append = (value) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().replace(/\\/g, '/');
    if (
      normalized.endsWith('.md')
      && !normalized.startsWith('/')
      && !normalized.startsWith('../')
      && !normalized.includes('/../')
      && (normalized === 'home.md' || normalized.startsWith('wiki/') || normalized.startsWith('source_cards/'))
    ) {
      paths.add(normalized);
    }
  };

  const output = trace.output;
  if (Array.isArray(output.sourcePaths)) {
    output.sourcePaths.forEach(append);
  }
  if (Array.isArray(output.sections)) {
    for (const section of output.sections) {
      if (section && typeof section === 'object' && Array.isArray(section.sourcePaths)) {
        section.sourcePaths.forEach(append);
      }
    }
  }
  return [...paths];
}

function compactTraceValue(value, depth = 0, keyHint = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const limit = isLargeTraceField(keyHint) ? TRACE_FIELD_PREVIEW_CHARS : TRACE_PREVIEW_CHARS;
    return compactString(value, limit);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (keyHint === 'catalog') return compactCatalogEntries(value);
    if (keyHint === 'materials') return compactMaterialEntries(value);
    if (keyHint === 'wikiPages') return compactMaterialEntries(value);
    if (keyHint === 'files') return compactFileEntries(value);
    if (keyHint === 'newSourceCards') return compactSourceCardEntries(value);
    const rows = value.slice(0, TRACE_ARRAY_LIMIT).map((item) => compactTraceValue(item, depth + 1, keyHint));
    if (value.length > TRACE_ARRAY_LIMIT) {
      rows.push({ omittedItems: value.length - TRACE_ARRAY_LIMIT });
    }
    return rows;
  }
  if (depth > 6) return { compacted: true, reason: 'maximum trace depth reached' };
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = compactTraceValue(nested, depth + 1, key);
  }
  return output;
}

function compactCatalogEntries(value) {
  return value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!item || typeof item !== 'object') return item;
    return {
      relativePath: item.relativePath,
      kind: item.kind,
      sourceType: item.sourceType,
      title: item.title,
      description: compactTextValue(item.description, 220),
      updatedAt: item.updatedAt,
      tags: item.tags,
      preview: compactTextValue(item.preview, 240),
    };
  }).concat(value.length > TRACE_ARRAY_LIMIT ? [{ omittedItems: value.length - TRACE_ARRAY_LIMIT }] : []);
}

function compactMaterialEntries(value) {
  return value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!item || typeof item !== 'object') return item;
    return {
      relativePath: item.relativePath,
      frontmatter: compactTraceValue(item.frontmatter, 1, 'frontmatter'),
      catalog: compactTraceValue(item.catalog, 1, 'catalogEntry'),
      content: compactTextValue(item.content, 360),
    };
  }).concat(value.length > TRACE_ARRAY_LIMIT ? [{ omittedItems: value.length - TRACE_ARRAY_LIMIT }] : []);
}

function compactFileEntries(value) {
  return value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!item || typeof item !== 'object') return item;
    return {
      path: item.path,
      content: compactTextValue(item.content, 240),
    };
  }).concat(value.length > TRACE_ARRAY_LIMIT ? [{ omittedItems: value.length - TRACE_ARRAY_LIMIT }] : []);
}

function compactSourceCardEntries(value) {
  return value.slice(0, TRACE_ARRAY_LIMIT).map((item) => {
    if (!item || typeof item !== 'object') return item;
    return {
      id: item.id,
      relativePath: item.relativePath,
      sourceType: item.sourceType,
      title: item.title,
      description: compactTextValue(item.description, 220),
      summary: compactTextValue(item.summary, 360),
      sourceRefs: compactTraceValue(item.sourceRefs, 1, 'sourceRefs'),
    };
  }).concat(value.length > TRACE_ARRAY_LIMIT ? [{ omittedItems: value.length - TRACE_ARRAY_LIMIT }] : []);
}

function compactTextValue(value, limit) {
  if (typeof value === 'string') return compactString(value, limit);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (typeof value.preview === 'string') {
      return {
        ...value,
        preview: compactString(value.preview, limit),
      };
    }
    return compactTraceValue(value, 1, 'text');
  }
  return String(value);
}

function compactString(value, limit) {
  if (value.length <= limit) return value;
  return {
    preview: `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`,
    chars: value.length,
    truncated: true,
  };
}

function isLargeTraceField(key) {
  return [
    'content',
    'digest',
    'messages',
    'recentMessages',
    'summary',
    'excerpt',
  ].includes(key);
}

function safeStringify(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function containsCompactedMarker(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (
    value.truncated === true
    && typeof value.preview === 'string'
    && typeof value.chars === 'number'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsCompactedMarker(item, depth + 1));
  }
  return Object.values(value).some((item) => containsCompactedMarker(item, depth + 1));
}

function parseMarkdown(content) {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return { frontmatter: {}, body: content };
  }
  return {
    frontmatter: parseSimpleFrontmatter(content.slice(4, end).trim()),
    body: content.slice(end + 4).replace(/^\s+/, ''),
  };
}

function parseSimpleFrontmatter(raw) {
  const output = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      const items = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const itemMatch = /^\s*-\s+(.*)$/.exec(lines[cursor]);
        if (!itemMatch) break;
        items.push(parseFrontmatterScalar(itemMatch[1].trim()));
        cursor += 1;
      }
      if (items.length > 0) {
        output[key] = items;
        index = cursor - 1;
      } else {
        output[key] = '';
      }
      continue;
    }
    if (value === '[]') {
      output[key] = [];
      continue;
    }
    output[key] = parseFrontmatterScalar(value);
  }
  return output;
}

function parseFrontmatterScalar(value) {
  if (value.startsWith('{') || value.startsWith('[') || value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function inferTitle(body) {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() ?? '';
}
