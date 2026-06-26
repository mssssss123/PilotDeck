import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Brain,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  History,
  Layers,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import type { Project } from '../../../../types/app';
import { authenticatedFetch } from '../../../../utils/api';

type ProjectWikiPanelProps = {
  selectedProject: Project | null;
};

type MarkdownItem = {
  relativePath: string;
  title: string;
  description?: string;
  updatedAt?: string;
  content: string;
  preview?: string;
  sourceType?: string;
  pageId?: string;
  frontmatter?: Record<string, unknown>;
  isPlaceholder?: boolean;
  sourceHealth?: SourceHealth;
};

type SourceHealth = {
  total: number;
  active: number;
  stale: number;
  conflict: number;
  draft: number;
  missing: number;
  warnings?: string[];
};

type TraceRecord = {
  id: string;
  kind: 'index' | 'maintain' | 'retrieval' | 'context';
  phase: string;
  createdAt: string;
  sessionId?: string;
  turnId?: string;
  status: 'success' | 'skipped' | 'error';
  model?: { provider: string; model: string };
  language?: 'en' | 'zh-CN';
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  payload?: { inputBytes?: number; outputBytes?: number; compacted?: boolean };
  payloadRefs?: { input?: string; output?: string };
  artifacts?: Array<{ kind: string; path?: string; id?: string; title?: string }>;
};

type ConflictRecord = {
  id: string;
  topic: string;
  summary: string;
  sourceCardIds?: string[];
  createdAt: string;
  updatedAt?: string;
  status?: 'open' | 'resolved';
  traceId?: string;
};

type MaintenanceEvent = {
  op: 'enqueue' | 'processed';
  key: string;
  cardId?: string;
  relativePath?: string;
  sourceType?: string;
  title?: string;
  sessionId?: string;
  turnId?: string;
  queuedAt?: string;
  processedAt?: string;
  traceId?: string;
};

type Snapshot = {
  projectPath: string;
  rootDir: string;
  exists: boolean;
  home: MarkdownItem | null;
  wikiPages: MarkdownItem[];
  sourceCards: MarkdownItem[];
  conflicts: ConflictRecord[];
  maintenance?: {
    pending: MaintenanceEvent[];
    processed: MaintenanceEvent[];
    pendingByType?: Record<string, number>;
  };
  traces: Record<'index' | 'maintain' | 'retrieval' | 'context', TraceRecord[]>;
  stats: {
    wikiPages: number;
    refinedWikiPages?: number;
    placeholderWikiPages?: number;
    sourceCards: number;
    staleSourceCards?: number;
    conflictedSourceCards?: number;
    staleWikiPages?: number;
    pendingMaintenanceCards?: number;
    processedMaintenanceCards?: number;
    conflicts?: number;
    openConflicts?: number;
    traces: number;
    sourceCardsByType: Record<string, number>;
  };
};

type ApiResponse = {
  success: boolean;
  snapshot?: Snapshot;
  error?: string;
};

type RefreshProjectWikiResult = {
  refreshed?: boolean;
  maxHistoricalTurns?: number;
  indexedTurns?: number;
  skippedTurns?: number;
  failedTurns?: number;
  scannedTranscripts?: number;
  discoveredTurns?: number;
  sourceCardsCreated?: number;
  diagnostics?: Array<{ severity?: string; message?: string }>;
};

type ViewId = 'wiki' | 'sources' | 'conflicts' | 'traces';
type TraceKind = 'index' | 'maintain' | 'retrieval' | 'context';

const VIEWS: Array<{ id: ViewId; labelKey: string; icon: typeof BookOpen }> = [
  { id: 'wiki', labelKey: 'views.wiki', icon: BookOpen },
  { id: 'sources', labelKey: 'views.sources', icon: Database },
  { id: 'conflicts', labelKey: 'views.conflicts', icon: TriangleAlert },
  { id: 'traces', labelKey: 'views.traces', icon: History },
];

const TRACE_KINDS: Array<{ id: TraceKind; labelKey: string }> = [
  { id: 'index', labelKey: 'traceKinds.index' },
  { id: 'maintain', labelKey: 'traceKinds.maintain' },
  { id: 'retrieval', labelKey: 'traceKinds.retrieval' },
  { id: 'context', labelKey: 'traceKinds.context' },
];

export default function ProjectWikiPanel({ selectedProject }: ProjectWikiPanelProps) {
  const { t } = useTranslation('projectWiki');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingProjectWiki, setRefreshingProjectWiki] = useState(false);
  const [activeView, setActiveView] = useState<ViewId>('wiki');
  const [selectedPage, setSelectedPage] = useState<string>('home.md');
  const [sourceType, setSourceType] = useState<string>('all');
  const [traceKind, setTraceKind] = useState<TraceKind>('retrieval');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [conflictUpdatingId, setConflictUpdatingId] = useState<string | null>(null);
  const [lastRefreshResult, setLastRefreshResult] = useState<RefreshProjectWikiResult | null>(null);

  const projectPath = selectedProject?.fullPath || selectedProject?.path || '';

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ projectPath, traceLimit: '120' });
      const response = await authenticatedFetch(`/api/project-wiki/snapshot?${params.toString()}`);
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.success || !payload.snapshot) {
        throw new Error(payload.error || t('errors.requestFailed', { status: response.status }));
      }
      setSnapshot(payload.snapshot);
      const firstPage = payload.snapshot.home?.relativePath
        || payload.snapshot.wikiPages[0]?.pageId
        || payload.snapshot.wikiPages[0]?.relativePath;
      if (firstPage) {
        setSelectedPage((current) => {
          if (current === 'home.md' && !payload.snapshot?.home) return firstPage;
          return current || firstPage;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectPath, t]);

  useEffect(() => {
    setSnapshot(null);
    setSelectedPage('home.md');
    setSelectedTraceId(null);
    setLastRefreshResult(null);
    if (projectPath) {
      void load();
    }
  }, [load, projectPath]);

  const sourceTypes = useMemo(() => {
    const types = new Set(snapshot?.sourceCards.map((card) => card.sourceType || 'unknown') ?? []);
    return ['all', ...Array.from(types).sort()];
  }, [snapshot]);

  const filteredSources = useMemo(() => {
    const cards = snapshot?.sourceCards ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (sourceType !== 'all' && card.sourceType !== sourceType) return false;
      if (!normalizedQuery) return true;
      return [
        card.title,
        card.description,
        card.relativePath,
        card.preview,
        readString(card.frontmatter?.id),
      ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
    });
  }, [query, snapshot, sourceType]);

  const selectedWikiPage = useMemo(() => {
    if (selectedPage === 'home.md') return snapshot?.home ?? null;
    const pages = snapshot?.wikiPages ?? [];
    return pages.find((page) => page.pageId === selectedPage || page.relativePath === selectedPage) ?? pages[0] ?? null;
  }, [selectedPage, snapshot]);

  const traces = snapshot?.traces[traceKind] ?? [];
  const traceCounts = useMemo(() => (
    TRACE_KINDS.reduce((acc, kind) => {
      acc[kind.id] = snapshot?.traces[kind.id]?.length ?? 0;
      return acc;
    }, {} as Record<TraceKind, number>)
  ), [snapshot]);
  const selectedTrace = traces.find((trace) => trace.id === selectedTraceId) ?? traces[0] ?? null;

  const selectTraceRun = (kind: TraceKind, id: string) => {
    setTraceKind(kind);
    setSelectedTraceId(id);
  };

  const inspectSourceCard = (card: MarkdownItem) => {
    setActiveView('sources');
    setSourceType(card.sourceType || 'all');
    setQuery(readString(card.frontmatter?.id) || card.title || card.relativePath);
  };
  const updateConflictStatus = async (conflictId: string, status: 'open' | 'resolved') => {
    if (!projectPath) return;
    setConflictUpdatingId(conflictId);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-wiki/conflict', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, conflictId, status }),
      });
      const payload = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.conflictUpdateFailed', { status: response.status }));
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConflictUpdatingId(null);
    }
  };
  const refreshProjectWiki = async () => {
    if (!projectPath) return;
    setRefreshingProjectWiki(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-wiki/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      const payload = await response.json() as {
        success?: boolean;
        error?: string;
        result?: RefreshProjectWikiResult;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.refreshFailed', { status: response.status }));
      }
      setLastRefreshResult(payload.result ?? { refreshed: true });
      await load();
    } catch (err) {
      setLastRefreshResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingProjectWiki(false);
    }
  };
  const inspectWikiPage = (page: MarkdownItem) => {
    setActiveView('wiki');
    setSelectedPage(page.pageId || page.relativePath);
  };
  const inspectTraceArtifact = (artifact: NonNullable<TraceRecord['artifacts']>[number]) => {
    const path = artifact.path || '';
    if (path === 'home.md') {
      setActiveView('wiki');
      setSelectedPage('home.md');
      return;
    }
    if (path.startsWith('wiki/')) {
      setActiveView('wiki');
      setSelectedPage(path);
      return;
    }
    if (path.startsWith('source_cards/')) {
      const sourceTypeFromPath = path.split('/')[1] || 'all';
      setActiveView('sources');
      setSourceType(sourceTypeFromPath);
      setQuery(path);
    }
  };
  const refinedWikiPages = snapshot?.stats.refinedWikiPages ?? snapshot?.stats.wikiPages ?? 0;
  const placeholderWikiPages = snapshot?.stats.placeholderWikiPages ?? 0;
  const staleWikiPages = snapshot?.stats.staleWikiPages ?? 0;
  const staleSourceCards = snapshot?.stats.staleSourceCards ?? 0;
  const pendingMaintenanceCards = snapshot?.stats.pendingMaintenanceCards ?? 0;

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('empty.selectProject')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 sm:px-5 dark:border-neutral-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Brain className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ProjectWiki
          </div>
          <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
            {snapshot?.rootDir || t('header.waiting')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Metric icon={BookOpen} label={t('metrics.refined')} value={refinedWikiPages} />
          {placeholderWikiPages > 0 && <Metric icon={FileText} label={t('metrics.pending')} value={placeholderWikiPages} />}
          <Metric icon={Layers} label={t('metrics.cards')} value={snapshot?.stats.sourceCards ?? 0} />
          {pendingMaintenanceCards > 0 && <Metric icon={RotateCcw} label={t('metrics.queued')} value={pendingMaintenanceCards} />}
          {(staleWikiPages > 0 || staleSourceCards > 0) && (
            <Metric icon={TriangleAlert} label={t('metrics.stale')} value={staleWikiPages + staleSourceCards} />
          )}
          {(snapshot?.stats.openConflicts ?? 0) > 0 && (
            <Metric icon={TriangleAlert} label={t('metrics.conflicts')} value={snapshot?.stats.openConflicts ?? 0} />
          )}
          <Metric icon={History} label={t('metrics.runs')} value={snapshot?.stats.traces ?? 0} />
          <button
            type="button"
            onClick={() => void refreshProjectWiki()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-[12px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200 dark:hover:bg-emerald-950/60"
            disabled={loading || refreshingProjectWiki}
            title={t('actions.indexNowTitle')}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${refreshingProjectWiki ? 'animate-spin' : ''}`} />
            {t('actions.indexNow')}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-[12px] font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:hover:bg-neutral-900"
            disabled={loading || refreshingProjectWiki}
            title={t('actions.refreshTitle')}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('actions.refresh')}
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[12px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {lastRefreshResult && !error && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-[12px] text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          {formatRefreshResult(lastRefreshResult, t)}
        </div>
      )}

      {snapshot && !snapshot.exists && !error && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          {t('empty.noData')}
        </div>
      )}

      {snapshot && snapshot.exists && refinedWikiPages === 0 && snapshot.stats.sourceCards === 0 && !error && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          {t('empty.initializedNoCards')}
        </div>
      )}

      <div className="flex overflow-x-auto border-b border-neutral-200 px-3 sm:px-5 dark:border-neutral-800">
        {VIEWS.map((view) => {
          const Icon = view.icon;
          const active = activeView === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => setActiveView(view.id)}
              className={`inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-[13px] font-medium ${
                active
                  ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t(view.labelKey)}
            </button>
          );
        })}
      </div>

      <main className="min-h-0 flex-1 overflow-hidden">
        {activeView === 'wiki' && (
          <WikiView
            home={snapshot?.home ?? null}
            pages={snapshot?.wikiPages ?? []}
            sourceCards={snapshot?.sourceCards ?? []}
            pendingMaintenance={snapshot?.maintenance?.pending ?? []}
            selectedPage={selectedWikiPage}
            onSelectPage={setSelectedPage}
            onInspectSourceCard={inspectSourceCard}
          />
        )}
        {activeView === 'sources' && (
          <SourcesView
            sourceTypes={sourceTypes}
            sourceType={sourceType}
            onSourceTypeChange={setSourceType}
            query={query}
            onQueryChange={setQuery}
            cards={filteredSources}
            wikiPages={snapshot?.wikiPages ?? []}
            onInspectWikiPage={inspectWikiPage}
          />
        )}
        {activeView === 'traces' && (
          <TracesView
            projectPath={projectPath}
            traceKind={traceKind}
            traceCounts={traceCounts}
            onTraceKindChange={setTraceKind}
            allTraces={snapshot?.traces ?? { index: [], maintain: [], retrieval: [], context: [] }}
            traces={traces}
            selectedTrace={selectedTrace}
            onSelectTrace={setSelectedTraceId}
            onSelectRelatedTrace={selectTraceRun}
            onInspectArtifact={inspectTraceArtifact}
          />
        )}
        {activeView === 'conflicts' && (
          <ConflictsView
            conflicts={snapshot?.conflicts ?? []}
            sourceCards={snapshot?.sourceCards ?? []}
            onInspectSourceCard={inspectSourceCard}
            onUpdateConflictStatus={updateConflictStatus}
            updatingConflictId={conflictUpdatingId}
          />
        )}
      </main>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof BookOpen; label: string; value: number }) {
  return (
    <div className="hidden h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-[12px] md:inline-flex dark:border-neutral-800">
      <Icon className="h-3.5 w-3.5 text-neutral-500" />
      <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function formatRefreshResult(result: RefreshProjectWikiResult, t: TFunction<'projectWiki'>): string {
  const parts = [
    typeof result.indexedTurns === 'number' ? t('refreshResult.indexedTurns', { count: result.indexedTurns }) : '',
    typeof result.skippedTurns === 'number' ? t('refreshResult.skippedTurns', { count: result.skippedTurns }) : '',
    typeof result.failedTurns === 'number' && result.failedTurns > 0 ? t('refreshResult.failedTurns', { count: result.failedTurns }) : '',
    typeof result.sourceCardsCreated === 'number' ? t('refreshResult.sourceCards', { count: result.sourceCardsCreated }) : '',
    typeof result.scannedTranscripts === 'number' ? t('refreshResult.transcripts', { count: result.scannedTranscripts }) : '',
    typeof result.maxHistoricalTurns === 'number' ? t('refreshResult.limit', { count: result.maxHistoricalTurns }) : '',
  ].filter(Boolean);
  const diagnostics = result.diagnostics
    ?.filter((diagnostic) => diagnostic.severity && diagnostic.severity !== 'info' && diagnostic.message)
    .map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`)
    .slice(0, 2);
  const summary = parts.length > 0 ? parts.join(' · ') : t('refreshResult.completed');
  return diagnostics && diagnostics.length > 0
    ? `${summary} · ${diagnostics.join(' · ')}`
    : summary;
}

function WikiView({
  home,
  pages,
  sourceCards,
  pendingMaintenance,
  selectedPage,
  onSelectPage,
  onInspectSourceCard,
}: {
  home: MarkdownItem | null;
  pages: MarkdownItem[];
  sourceCards: MarkdownItem[];
  pendingMaintenance: MaintenanceEvent[];
  selectedPage: MarkdownItem | null;
  onSelectPage: (id: string) => void;
  onInspectSourceCard: (card: MarkdownItem) => void;
}) {
  const { t } = useTranslation('projectWiki');
  const hasAnyPage = Boolean(home) || pages.length > 0;
  const selectedSourceIds = readStringArray(selectedPage?.frontmatter?.sourceCardIds);
  const selectedSourceCards = selectedSourceIds
    .map((id) => sourceCards.find((card) => readString(card.frontmatter?.id) === id))
    .filter((card): card is MarkdownItem => Boolean(card));
  const missingSourceCount = selectedSourceIds.length - selectedSourceCards.length;
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(180px,32vh)_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="min-h-0 overflow-y-auto border-b border-neutral-200 p-3 lg:border-b-0 lg:border-r dark:border-neutral-800">
        {!hasAnyPage ? (
          <EmptyState text={t('empty.noWikiPages')} />
        ) : (
          <>
            {home && (
              <button
                type="button"
                onClick={() => onSelectPage(home.relativePath)}
                className={`mb-3 block w-full rounded-md border p-3 text-left ${
                  selectedPage?.relativePath === home.relativePath
                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                    : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
                }`}
              >
                <div className="flex items-center gap-2 text-[13px] font-semibold">
                  <BookOpen className="h-4 w-4 text-neutral-500" />
                  <span className="truncate">{wikiPageDisplayTitle(home, t)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                  {wikiPageDisplayDescription(home, t) || home.relativePath}
                </div>
              </button>
            )}
            {pages.map((page) => {
              const active = selectedPage?.relativePath === page.relativePath;
              const health = page.sourceHealth;
              return (
                <button
                  key={page.relativePath}
                  type="button"
                  onClick={() => onSelectPage(page.pageId || page.relativePath)}
                  className={`mb-2 block w-full rounded-md border p-3 text-left ${
                    active
                      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                      : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <FileText className="h-4 w-4 text-neutral-500" />
                    <span className="truncate">{wikiPageDisplayTitle(page, t)}</span>
                    {page.isPlaceholder && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        {t('status.pending')}
                      </span>
                    )}
                    {health && hasSourceHealthRisk(health) && (
                      <SourceHealthPill health={health} compact />
                    )}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                    {wikiPageDisplayDescription(page, t) || page.relativePath}
                  </div>
                </button>
              );
            })}
          </>
        )}
      </aside>
      <section className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5 lg:px-7 lg:py-5">
        {selectedPage ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-neutral-500 dark:text-neutral-400">
              <span>{selectedPage.relativePath}</span>
              {selectedPage.updatedAt && <span>{t('meta.updated', { date: formatDate(selectedPage.updatedAt) })}</span>}
              {selectedPage.sourceHealth && hasSourceHealthRisk(selectedPage.sourceHealth) && (
                <SourceHealthPill health={selectedPage.sourceHealth} />
              )}
              {selectedPage.isPlaceholder && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  {t('status.pendingRefinement')}
                </span>
              )}
            </div>
            {selectedPage.isPlaceholder ? (
              <PendingWikiPage page={selectedPage} pendingMaintenance={pendingMaintenance} />
            ) : selectedPage.relativePath.startsWith('wiki/') && (
              <WikiPageSources
                cards={selectedSourceCards}
                missingCount={missingSourceCount}
                sourceHealth={selectedPage.sourceHealth}
                onInspectSourceCard={onInspectSourceCard}
              />
            )}
            {!selectedPage.isPlaceholder && (
              selectedPage.relativePath === 'home.md'
                ? <ProjectWikiHomeBody />
                : <Markdown content={selectedPage.content} />
            )}
          </>
        ) : (
          <EmptyState text={t('empty.noWikiPageSelected')} />
        )}
      </section>
    </div>
  );
}

function PendingWikiPage({
  page,
  pendingMaintenance,
}: {
  page: MarkdownItem;
  pendingMaintenance: MaintenanceEvent[];
}) {
  const { t } = useTranslation('projectWiki');
  const pendingByType = summarizePendingMaintenance(pendingMaintenance, t);
  return (
    <section className="max-w-3xl rounded-md border border-dashed border-amber-200 bg-amber-50/70 p-4 text-[13px] leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
      <div className="mb-1 font-semibold">{t('pendingPage.title', { title: wikiPageDisplayTitle(page, t) })}</div>
      <div>
        {t('pendingPage.description')}
        {pendingMaintenance.length > 0
          ? ` ${t('pendingPage.queued')}`
          : ` ${t('pendingPage.waitingForMaterial')}`}
      </div>
      {pendingMaintenance.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-200 bg-white/60 p-3 dark:border-amber-900/60 dark:bg-neutral-950/40">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
            <RotateCcw className="h-3.5 w-3.5" />
            {t('pendingPage.queueTitle')}
          </div>
          <div className="mb-2 text-[12px] text-amber-800/80 dark:text-amber-200/80">
            {t('pendingPage.queueSummary', { count: pendingMaintenance.length })}
            {pendingByType ? `: ${pendingByType}` : t('punctuation.period')}
          </div>
          <div className="grid gap-2">
            {pendingMaintenance.slice(0, 4).map((event) => (
              <div key={event.key} className="min-w-0 rounded border border-amber-100 bg-white px-2.5 py-2 dark:border-amber-900/50 dark:bg-neutral-950">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    {sourceTypeLabel(event.sourceType || 'source', t)}
                  </span>
                  <span className="truncate font-semibold text-amber-950 dark:text-amber-100">
                    {event.title || event.cardId || event.relativePath || t('pendingPage.queuedSourceCard')}
                  </span>
                </div>
                {event.relativePath && (
                  <div className="mt-1 truncate text-[11px] text-amber-700/70 dark:text-amber-200/70">
                    {event.relativePath}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function WikiPageSources({
  cards,
  missingCount,
  sourceHealth,
  onInspectSourceCard,
}: {
  cards: MarkdownItem[];
  missingCount: number;
  sourceHealth?: SourceHealth;
  onInspectSourceCard: (card: MarkdownItem) => void;
}) {
  const { t } = useTranslation('projectWiki');
  if (cards.length === 0 && missingCount <= 0) {
    return (
      <section className="mb-5 rounded-md border border-dashed border-neutral-200 bg-neutral-50 p-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-400">
        {t('wikiSources.empty')}
      </section>
    );
  }
  return (
    <section className="mb-5 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
          {t('wikiSources.title')}
        </div>
        <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
          {t('wikiSources.linked', { count: cards.length })}{missingCount > 0 ? ` · ${t('wikiSources.missing', { count: missingCount })}` : ''}
        </div>
      </div>
      {sourceHealth && hasSourceHealthRisk(sourceHealth) && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          <div className="font-semibold">{t('wikiSources.needsReview')}</div>
          {sourceHealth.warnings && sourceHealth.warnings.length > 0 && (
            <div className="mt-1">{sourceHealth.warnings.slice(0, 2).join(' ')}</div>
          )}
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {cards.map((card) => (
          <button
            key={card.relativePath}
            type="button"
            onClick={() => onInspectSourceCard(card)}
            className="min-w-0 rounded-md border border-neutral-200 bg-white p-2.5 text-left hover:border-emerald-300 hover:bg-emerald-50/50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-emerald-900 dark:hover:bg-emerald-950/20"
          >
            <div className="mb-1 flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
                {sourceTypeLabel(card.sourceType || 'source', t)}
              </span>
              <SourceStatusPill status={readString(card.frontmatter?.status)} />
              <span className="truncate text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">
                {card.title}
              </span>
            </div>
            <div className="line-clamp-2 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {card.description || card.preview || card.relativePath}
            </div>
            <SourceQualityPills card={card} compact />
            <div className="mt-1 truncate text-[11px] text-neutral-400">
              {card.relativePath}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function ProjectWikiHomeBody() {
  const { t } = useTranslation('projectWiki');
  return (
    <div className="max-w-3xl space-y-5 text-[14px] leading-relaxed text-neutral-700 dark:text-neutral-200">
      <section>
        <h2 className="mb-2 text-[18px] font-semibold text-neutral-950 dark:text-neutral-50">{t('home.bodyTitle')}</h2>
        <p>{t('home.bodyDescription')}</p>
      </section>
      <section>
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-neutral-500">{t('home.wikiPagesTitle')}</h3>
        <ul className="space-y-1">
          <li><code>wiki/project-overview.md</code>: {t('wikiPages.projectOverview.description')}</li>
          <li><code>wiki/project-status.md</code>: {t('wikiPages.projectStatus.description')}</li>
          <li><code>wiki/project-feedback.md</code>: {t('wikiPages.projectFeedback.description')}</li>
          <li><code>wiki/knowledge.md</code>: {t('wikiPages.knowledge.description')}</li>
        </ul>
      </section>
      <section>
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-neutral-500">{t('home.sourceCardsTitle')}</h3>
        <ul className="space-y-1">
          <li><code>source_cards/repo/</code>: {t('home.sourceCards.repo')}</li>
          <li><code>source_cards/memory/</code>: {t('home.sourceCards.memory')}</li>
          <li><code>source_cards/conversations/</code>: {t('home.sourceCards.conversations')}</li>
          <li><code>source_cards/knowledge/</code>: {t('home.sourceCards.knowledge')}</li>
        </ul>
      </section>
    </div>
  );
}

function SourcesView({
  sourceTypes,
  sourceType,
  onSourceTypeChange,
  query,
  onQueryChange,
  cards,
  wikiPages,
  onInspectWikiPage,
}: {
  sourceTypes: string[];
  sourceType: string;
  onSourceTypeChange: (value: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  cards: MarkdownItem[];
  wikiPages: MarkdownItem[];
  onInspectWikiPage: (page: MarkdownItem) => void;
}) {
  const { t } = useTranslation('projectWiki');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col items-stretch gap-3 border-b border-neutral-200 px-4 py-3 sm:flex-row sm:items-center sm:px-5 dark:border-neutral-800">
        <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('sources.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-neutral-200 bg-white pl-9 pr-3 text-[13px] outline-none focus:border-emerald-500 dark:border-neutral-800 dark:bg-neutral-950"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible sm:pb-0">
          {sourceTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onSourceTypeChange(type)}
              className={`h-8 shrink-0 rounded-md px-2.5 text-[12px] font-medium ${
                sourceType === type
                  ? 'bg-emerald-600 text-white'
                  : 'border border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900'
              }`}
            >
              {sourceTypeLabel(type, t)}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {cards.length === 0 ? (
          <EmptyState text={query.trim() || sourceType !== 'all'
            ? t('sources.noMatches')
            : t('sources.empty')}
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
	            {cards.map((card) => (
	              <article key={card.relativePath} className="min-w-0 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
	                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                        {sourceTypeLabel(card.sourceType || 'source', t)}
                      </span>
                      <SourceStatusPill status={readString(card.frontmatter?.status)} />
                    </div>
	                  <span className="min-w-0 truncate text-[11px] text-neutral-400">{card.relativePath}</span>
	                </div>
                <h3 className="text-[14px] font-semibold">{card.title}</h3>
                <p className="mt-1 line-clamp-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                  {card.description || card.preview}
                </p>
                <SourceQualityPills card={card} />
                <SourceCardTraceability
                  card={card}
                  wikiPages={wikiPages}
                  onInspectWikiPage={onInspectWikiPage}
                />
                <details className="mt-3">
                  <summary className="cursor-pointer text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                    {t('sources.showCardBody')}
                  </summary>
                  <div className="mt-3 max-h-80 overflow-auto rounded-md bg-neutral-50 p-3 dark:bg-neutral-900">
                    <Markdown content={card.content} compact />
                  </div>
                </details>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictsView({
  conflicts,
  sourceCards,
  onInspectSourceCard,
  onUpdateConflictStatus,
  updatingConflictId,
}: {
  conflicts: ConflictRecord[];
  sourceCards: MarkdownItem[];
  onInspectSourceCard: (card: MarkdownItem) => void;
  onUpdateConflictStatus: (conflictId: string, status: 'open' | 'resolved') => void;
  updatingConflictId: string | null;
}) {
  const { t } = useTranslation('projectWiki');
  const cardById = useMemo(() => {
    const map = new Map<string, MarkdownItem>();
    for (const card of sourceCards) {
      const id = readString(card.frontmatter?.id);
      if (id) map.set(id, card);
    }
    return map;
  }, [sourceCards]);
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 sm:p-5">
      {conflicts.length === 0 ? (
        <EmptyState text={t('conflicts.empty')} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {conflicts.map((conflict) => {
            const resolved = conflict.status === 'resolved';
            const updating = updatingConflictId === conflict.id;
            return (
              <article
                key={conflict.id}
                className={`rounded-md border p-4 ${
                  resolved
                    ? 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
                    : 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {conflict.topic}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      resolved
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                    }`}
                    >
	                      {conflictStatusLabel(conflict.status || 'open', t)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onUpdateConflictStatus(conflict.id, resolved ? 'open' : 'resolved')}
                      disabled={updating}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 text-[11px] font-medium text-neutral-700 hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-emerald-900 dark:hover:bg-emerald-950/20"
	                      title={resolved ? t('conflicts.reopenTitle') : t('conflicts.resolveTitle')}
                    >
                      {resolved ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
	                      {updating ? t('actions.updating') : resolved ? t('conflicts.reopen') : t('conflicts.markResolved')}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                  {conflict.summary}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <span className="rounded bg-white px-1.5 py-0.5 dark:bg-neutral-950">{formatDate(conflict.createdAt)}</span>
                  {conflict.traceId && <span className="rounded bg-white px-1.5 py-0.5 dark:bg-neutral-950">{t('meta.trace', { id: shortId(conflict.traceId) })}</span>}
                </div>
                {(conflict.sourceCardIds ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(conflict.sourceCardIds ?? []).map((id) => {
                      const card = cardById.get(id);
                      return card ? (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onInspectSourceCard(card)}
                          className="rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:bg-neutral-950 dark:text-amber-200 dark:hover:bg-amber-950/70"
                          title={t('actions.openPath', { path: card.relativePath })}
                        >
                          {shortId(id)}
                        </button>
                      ) : (
                        <span key={id} className="rounded bg-white px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-950">
                          {shortId(id)}
                        </span>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SourceCardTraceability({
  card,
  wikiPages,
  onInspectWikiPage,
}: {
  card: MarkdownItem;
  wikiPages: MarkdownItem[];
  onInspectWikiPage: (page: MarkdownItem) => void;
}) {
  const { t } = useTranslation('projectWiki');
  const refs = readRecordArray(card.frontmatter?.sourceRefs);
  const cardId = readString(card.frontmatter?.id);
  const linkedPages = cardId
    ? wikiPages.filter((page) => readStringArray(page.frontmatter?.sourceCardIds).includes(cardId))
    : [];
  if (refs.length === 0 && linkedPages.length === 0 && !card.updatedAt) return null;
  const refKinds = [...new Set(refs.map((ref) => readString(ref.kind)).filter(Boolean))];
  return (
    <div className="mt-3 space-y-2 text-[11px] text-neutral-500 dark:text-neutral-400">
      <div className="flex flex-wrap items-center gap-1.5">
        {refs.length > 0 && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">
            {t('sourceTrace.refs', { count: refs.length })}{refKinds.length > 0 ? ` · ${refKinds.join(', ')}` : ''}
          </span>
        )}
        {linkedPages.length > 0 && (
          <>
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {t('sourceTrace.usedBy')}
            </span>
            {linkedPages.map((page) => (
              <button
                key={page.relativePath}
                type="button"
                onClick={() => onInspectWikiPage(page)}
                className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                title={t('actions.openPath', { path: page.relativePath })}
              >
                {wikiPageDisplayTitle(page, t) || page.pageId || page.relativePath}
              </button>
            ))}
          </>
        )}
        {card.updatedAt && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">
            {formatDate(card.updatedAt)}
          </span>
        )}
      </div>
      {refs.length > 0 && (
        <div className="space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900/60">
          {refs.slice(0, 2).map((ref, index) => (
            <SourceRefLine key={`${readString(ref.kind)}-${readString(ref.label)}-${index}`} refRecord={ref} />
          ))}
          {refs.length > 2 && (
            <div className="text-[11px] text-neutral-400">
              {t('sourceTrace.moreRefs', { count: refs.length - 2 })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceQualityPills({ card, compact = false }: { card: MarkdownItem; compact?: boolean }) {
  const { t } = useTranslation('projectWiki');
  const evidenceLevel = readString(card.frontmatter?.evidenceLevel);
  const confidence = readNumber(card.frontmatter?.confidence);
  const qualitySignals = readStringArray(card.frontmatter?.qualitySignals);
  if (!evidenceLevel && confidence === undefined && qualitySignals.length === 0) return null;
  const evidenceClass = evidenceLevel === 'high'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : evidenceLevel === 'medium'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300';
  const containerClass = compact
    ? 'mt-1 flex flex-wrap items-center gap-1 text-[10px]'
    : 'mt-2 flex flex-wrap items-center gap-1.5 text-[11px]';
  return (
    <div className={containerClass}>
      {evidenceLevel && (
        <span className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${evidenceClass}`}>
          {t('quality.evidence', { value: formatQualitySignal(evidenceLevel) })}
        </span>
      )}
      {confidence !== undefined && (
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          {t('quality.confidence', { value: Math.round(confidence * 100) })}
        </span>
      )}
      {qualitySignals.slice(0, compact ? 1 : 3).map((signal) => (
        <span
          key={signal}
          className="rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
        >
          {formatQualitySignal(signal)}
        </span>
      ))}
      {qualitySignals.length > (compact ? 1 : 3) && (
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          +{qualitySignals.length - (compact ? 1 : 3)}
        </span>
      )}
    </div>
  );
}

function formatQualitySignal(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function SourceRefLine({ refRecord }: { refRecord: Record<string, unknown> }) {
  const { t } = useTranslation('projectWiki');
  const kind = readString(refRecord.kind) || 'source';
  const label = readString(refRecord.label);
  const path = readString(refRecord.path);
  const sessionId = readString(refRecord.sessionId);
  const turnId = readString(refRecord.turnId);
  const messageId = readString(refRecord.messageId);
  const excerpt = readString(refRecord.excerpt);
  const contentHash = readString(refRecord.contentHash);
  const range = readRangeLabel(refRecord.range);
  const primary = path || label || sessionId || messageId || kind;
  const secondary = [
    sessionId ? t('sourceRef.session', { id: shortId(sessionId) }) : '',
    turnId ? t('sourceRef.turn', { id: shortId(turnId) }) : '',
    messageId,
    range ? t('sourceRef.range', { range }) : '',
    contentHash ? t('sourceRef.hash', { hash: shortId(contentHash) }) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
          {kind}
        </span>
        <span className="truncate text-neutral-700 dark:text-neutral-200" title={primary}>
          {primary}
        </span>
      </div>
      {secondary && (
        <div className="mt-0.5 truncate pl-12 text-neutral-400" title={secondary}>
          {secondary}
        </div>
      )}
      {excerpt && (
        <div className="mt-1 line-clamp-2 text-neutral-500 dark:text-neutral-400">
          {excerpt}
        </div>
      )}
    </div>
  );
}

function SourceStatusPill({ status }: { status: string }) {
  const { t } = useTranslation('projectWiki');
  if (!status || status === 'active') return null;
  const className = status === 'stale'
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
    : status === 'conflict'
      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {sourceStatusLabel(status, t)}
    </span>
  );
}

function SourceHealthPill({ health, compact = false }: { health: SourceHealth; compact?: boolean }) {
  const { t } = useTranslation('projectWiki');
  const label = [
    health.stale > 0 ? t('health.stale', { count: health.stale }) : '',
    health.conflict > 0 ? t('health.conflict', { count: health.conflict }) : '',
    health.missing > 0 ? t('health.missing', { count: health.missing }) : '',
  ].filter(Boolean).join(' · ');
  if (!label) return null;
  return (
    <span
      className={`shrink-0 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200 ${
        compact ? 'text-[10px] uppercase' : 'text-[11px]'
      }`}
      title={health.warnings?.join(' ') || label}
    >
      {compact ? t('health.staleCompact') : label}
    </span>
  );
}

function hasSourceHealthRisk(health?: SourceHealth): boolean {
  return Boolean(health && (health.stale > 0 || health.conflict > 0 || health.missing > 0));
}

function TracesView({
  projectPath,
  traceKind,
  traceCounts,
  onTraceKindChange,
  allTraces,
  traces,
  selectedTrace,
  onSelectTrace,
  onSelectRelatedTrace,
  onInspectArtifact,
}: {
  projectPath: string;
  traceKind: TraceKind;
  traceCounts: Record<TraceKind, number>;
  onTraceKindChange: (kind: TraceKind) => void;
  allTraces: Record<TraceKind, TraceRecord[]>;
  traces: TraceRecord[];
  selectedTrace: TraceRecord | null;
  onSelectTrace: (id: string) => void;
  onSelectRelatedTrace: (kind: TraceKind, id: string) => void;
  onInspectArtifact: (artifact: NonNullable<TraceRecord['artifacts']>[number]) => void;
}) {
  const { t } = useTranslation('projectWiki');
  const relatedTraces = getRelatedTraces(selectedTrace, allTraces);
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(220px,38vh)_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="min-h-0 overflow-y-auto border-b border-neutral-200 lg:border-b-0 lg:border-r dark:border-neutral-800">
        <div className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
          {TRACE_KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              onClick={() => onTraceKindChange(kind.id)}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium ${
                traceKind === kind.id
                  ? 'bg-emerald-600 text-white'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900'
              }`}
            >
              <span>{t(kind.labelKey)}</span>
              <span className={`rounded px-1 text-[10px] ${
                traceKind === kind.id
                  ? 'bg-white/20 text-white'
                  : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
              }`}
              >
                {traceCounts[kind.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <div className="p-3">
          {traces.length === 0 ? (
            <EmptyState text={t('traces.emptyType')} />
          ) : traces.map((trace) => {
            const active = selectedTrace?.id === trace.id;
            return (
              <button
                key={trace.id}
                type="button"
                onClick={() => onSelectTrace(trace.id)}
                className={`mb-2 block w-full rounded-md border p-3 text-left ${
                  active
                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                    : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
	                  <span className="text-[13px] font-semibold">{tracePhaseLabel(trace, t)}</span>
                  <StatusPill status={trace.status} />
                </div>
                <div className="mt-1 text-[12px] text-neutral-500 dark:text-neutral-400">
                  {formatDate(trace.createdAt)}
                </div>
                <div className="mt-1 truncate text-[11px] text-neutral-400">
	                  {trace.model ? `${trace.model.provider}/${trace.model.model}` : t('traces.noModelRecorded')}
                </div>
              </button>
            );
          })}
        </div>
      </aside>
      <section className="min-h-0 overflow-y-auto p-4 sm:p-5">
        {selectedTrace ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <GitBranch className="h-4 w-4 text-neutral-500" />
              <h2 className="text-[15px] font-semibold">
	                {traceKindLabel(selectedTrace.kind, t)} / {tracePhaseLabel(selectedTrace, t)}
              </h2>
              <StatusPill status={selectedTrace.status} />
              {selectedTrace.durationMs !== undefined && (
                <span className="text-[12px] text-neutral-500">{selectedTrace.durationMs}ms</span>
              )}
            </div>
            {selectedTrace.error && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                {selectedTrace.error}
              </div>
            )}
            <TraceDecision trace={selectedTrace} />
            <TraceTurnFlow
              selectedTrace={selectedTrace}
              relatedTraces={relatedTraces}
              onSelectTrace={onSelectRelatedTrace}
            />
            <TraceBlock title={t('traces.model')} value={selectedTrace.model ? `${selectedTrace.model.provider}/${selectedTrace.model.model}` : t('traces.notRecorded')} />
            <TraceBlock title={t('traces.language')} value={traceLanguageLabel(selectedTrace.language, t)} />
            {selectedTrace.payload?.compacted && (
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-[12px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
	                {t('traces.compactedPayload')}
              </div>
            )}
            <TracePayloadRefs projectPath={projectPath} refs={selectedTrace.payloadRefs} />
            <TraceArtifacts artifacts={selectedTrace.artifacts ?? []} onInspectArtifact={onInspectArtifact} />
            <TraceJson title={t('traces.input')} value={selectedTrace.input} />
            <TraceJson title={t('traces.outputDecision')} value={selectedTrace.output} />
          </div>
        ) : (
	          <EmptyState text={t('traces.selectRun')} />
        )}
      </section>
    </div>
  );
}

function TraceTurnFlow({
  selectedTrace,
  relatedTraces,
  onSelectTrace,
}: {
  selectedTrace: TraceRecord;
  relatedTraces: TraceRecord[];
  onSelectTrace: (kind: TraceKind, id: string) => void;
}) {
  const { t } = useTranslation('projectWiki');
  if (!selectedTrace.sessionId && !selectedTrace.turnId) return null;
  return (
    <section className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
	          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{t('turnFlow.title')}</h3>
          <div className="mt-1 text-[12px] text-neutral-500 dark:text-neutral-400">
	            {selectedTrace.sessionId && <span>{t('sourceRef.session', { id: shortId(selectedTrace.sessionId) })}</span>}
	            {selectedTrace.sessionId && selectedTrace.turnId && <span> · </span>}
	            {selectedTrace.turnId && <span>{t('sourceRef.turn', { id: shortId(selectedTrace.turnId) })}</span>}
          </div>
        </div>
        <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
	          {t('turnFlow.steps', { count: relatedTraces.length })}
        </div>
      </div>
      {relatedTraces.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-200 p-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
	          {t('turnFlow.noRelated')}
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {relatedTraces.map((trace) => {
            const active = trace.id === selectedTrace.id;
            return (
              <button
                key={trace.id}
                type="button"
                onClick={() => onSelectTrace(trace.kind, trace.id)}
                className={`min-w-0 rounded-md border p-2.5 text-left ${
                  active
                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                    : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
                }`}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
	                      {traceRoleLabel(trace.kind, t)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
	                      {traceKindLabel(trace.kind, t)} / {tracePhaseLabel(trace, t)}
                    </div>
                  </div>
                  <StatusPill status={trace.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <span>{formatDate(trace.createdAt)}</span>
                  {trace.durationMs !== undefined && <span>{trace.durationMs}ms</span>}
                  {trace.artifacts && trace.artifacts.length > 0 && (
	                    <span>{t('traces.artifactCount', { count: trace.artifacts.length })}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TraceDecision({ trace }: { trace: TraceRecord }) {
  const { t } = useTranslation('projectWiki');
  const decision = describeTraceDecision(trace, t);
  if (!decision) return null;
  return (
    <section className="rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/60">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{decision.title}</h3>
      {decision.summary && (
        <p className="mb-3 text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200">
          {decision.summary}
        </p>
      )}
      {decision.items.length > 0 && (
        <div className="space-y-2">
          {decision.items.map((item) => (
            <div key={item.key} className="rounded-md border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-950">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-semibold text-neutral-800 dark:text-neutral-100">{item.label}</span>
                {item.meta && <span className="text-neutral-500 dark:text-neutral-400">{item.meta}</span>}
              </div>
              {item.detail && (
                <div className="mt-1 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {item.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function getRelatedTraces(
  selectedTrace: TraceRecord | null,
  allTraces: Record<TraceKind, TraceRecord[]>,
): TraceRecord[] {
  if (!selectedTrace?.sessionId && !selectedTrace?.turnId) return [];
  const rows = TRACE_KINDS.flatMap((kind) => allTraces[kind.id] ?? []);
  return rows
    .filter((trace) => {
      if (selectedTrace.turnId && trace.turnId === selectedTrace.turnId) return true;
      return Boolean(selectedTrace.sessionId && trace.sessionId === selectedTrace.sessionId);
    })
    .sort((left, right) => {
      const leftRole = TRACE_KINDS.findIndex((kind) => kind.id === left.kind);
      const rightRole = TRACE_KINDS.findIndex((kind) => kind.id === right.kind);
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return leftRole - rightRole;
    });
}

function traceRoleLabel(kind: TraceKind, t: TFunction<'projectWiki'>): string {
  if (kind === 'retrieval') return t('traceRoles.retrieval');
  if (kind === 'context') return t('traceRoles.context');
  if (kind === 'index') return t('traceRoles.index');
  return t('traceRoles.maintain');
}

function traceKindLabel(kind: TraceKind, t: TFunction<'projectWiki'>): string {
  if (kind === 'retrieval') return t('traceKinds.retrieval');
  if (kind === 'context') return t('traceKinds.context');
  if (kind === 'index') return t('traceKinds.index');
  return t('traceKinds.maintain');
}

function traceLanguageLabel(language: TraceRecord['language'], t: TFunction<'projectWiki'>): string {
  if (language === 'zh-CN') return t('traces.languageZh');
  if (language === 'en') return t('traces.languageEn');
  return t('traces.notRecorded');
}

function tracePhaseLabel(trace: Pick<TraceRecord, 'kind' | 'phase'>, t: TFunction<'projectWiki'>): string {
  const phase = trace.phase;
  if (trace.kind === 'retrieval') {
    if (phase === 'tool_loop') return t('tracePhases.toolLoop');
    if (phase === 'tool_loop_fallback') return t('tracePhases.toolLoopFallback');
    if (phase === 'tool_catalog_search') return t('tracePhases.toolCatalogSearch');
    if (phase === 'tool_catalog_search_failed') return t('tracePhases.toolCatalogSearchFailed');
    if (phase === 'search') return t('tracePhases.search');
    if (phase === 'read') return t('tracePhases.read');
    if (phase === 'search_failed') return t('tracePhases.searchFailed');
    if (phase === 'retrieve_failed') return t('tracePhases.retrieveFailed');
  }
  if (trace.kind === 'context') {
    if (phase === 'assemble') return t('tracePhases.assemble');
    if (phase === 'assemble_failed') return t('tracePhases.assembleFailed');
    if (phase === 'retrieve_failed') return t('tracePhases.retrieveFailed');
  }
  if (trace.kind === 'index') {
    if (phase === 'turn') return t('tracePhases.turn');
    if (phase === 'turn_failed') return t('tracePhases.turnFailed');
    if (phase === 'repo') return t('tracePhases.repo');
    if (phase === 'repo_failed') return t('tracePhases.repoFailed');
    if (phase === 'source_freshness') return t('tracePhases.sourceFreshness');
    if (phase === 'source_freshness_failed') return t('tracePhases.sourceFreshnessFailed');
    if (phase === 'legacy_memory' || phase === 'legacy_memory_migration') return t('tracePhases.importedMemory');
    if (phase === 'legacy_memory_failed' || phase === 'legacy_memory_migration_failed') return t('tracePhases.importedMemoryFailed');
    if (phase === 'history_backfill') return t('tracePhases.historyBackfill');
    if (phase === 'history_backfill_failed') return t('tracePhases.historyBackfillFailed');
    if (phase === 'capture_failed') return t('tracePhases.captureFailed');
  }
  if (trace.kind === 'maintain') {
    if (phase === 'wiki') return t('tracePhases.wiki');
    if (phase === 'wiki_failed') return t('tracePhases.wikiFailed');
  }
  return sourceTypeLabel(phase, t);
}

type TracePayloadState = {
  loading?: boolean;
  content?: string;
  error?: string;
};

function TracePayloadRefs({
  projectPath,
  refs,
}: {
  projectPath: string;
  refs?: TraceRecord['payloadRefs'];
}) {
  const { t } = useTranslation('projectWiki');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<Record<string, TracePayloadState>>({});
  const rows = [
    refs?.input ? { label: t('payload.rawInput'), path: refs.input } : null,
    refs?.output ? { label: t('payload.rawOutput'), path: refs.output } : null,
  ].filter((row): row is { label: string; path: string } => Boolean(row));
  if (rows.length === 0) return null;

  const loadPayload = async (relativePath: string) => {
    if (openPath === relativePath) {
      setOpenPath(null);
      return;
    }
    setOpenPath(relativePath);
    if (payloads[relativePath]?.content || payloads[relativePath]?.loading) return;
    setPayloads((current) => ({
      ...current,
      [relativePath]: { loading: true },
    }));
    try {
      const params = new URLSearchParams({ projectPath, path: relativePath });
      const response = await authenticatedFetch(`/api/project-wiki/payload?${params.toString()}`);
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('errors.payloadFailed', { status: response.status }));
      }
      setPayloads((current) => ({
        ...current,
        [relativePath]: { content: body.payload?.content ?? '' },
      }));
    } catch (caught) {
      setPayloads((current) => ({
        ...current,
        [relativePath]: {
	          error: caught instanceof Error ? caught.message : t('payload.loadFailed'),
        },
      }));
    }
  };

  return (
    <section>
	      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{t('payload.title')}</h3>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0 rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60">
            <button
              type="button"
              onClick={() => void loadPayload(row.path)}
              className="flex w-full min-w-0 items-center justify-between gap-3 p-2.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{row.label}</span>
                <span className="mt-1 block truncate text-[12px] text-neutral-700 dark:text-neutral-200" title={row.path}>
                  {row.path}
                </span>
              </span>
              <span className="shrink-0 rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] font-medium text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
	                {openPath === row.path ? t('actions.hide') : t('actions.open')}
              </span>
            </button>
            {openPath === row.path && (
              <div className="border-t border-neutral-200 dark:border-neutral-800">
                {payloads[row.path]?.loading ? (
	                  <div className="p-3 text-[12px] text-neutral-500 dark:text-neutral-400">{t('payload.loading')}</div>
                ) : payloads[row.path]?.error ? (
                  <div className="p-3 text-[12px] text-red-600 dark:text-red-300">{payloads[row.path]?.error}</div>
                ) : (
                  <pre className="max-h-[520px] overflow-auto bg-white p-3 text-[12px] leading-relaxed text-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
	                    {payloads[row.path]?.content || t('payload.empty')}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TraceArtifacts({
  artifacts,
  onInspectArtifact,
}: {
  artifacts: NonNullable<TraceRecord['artifacts']>;
  onInspectArtifact: (artifact: NonNullable<TraceRecord['artifacts']>[number]) => void;
}) {
  const { t } = useTranslation('projectWiki');
  if (artifacts.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{t('artifacts.title')}</h3>
      <div className="flex flex-wrap gap-2">
        {artifacts.map((artifact, index) => {
          const navigable = Boolean(artifact.path && (
            artifact.path === 'home.md'
            || artifact.path.startsWith('wiki/')
            || artifact.path.startsWith('source_cards/')
          ));
	          const label = artifact.title || artifact.path || artifact.id || t('artifacts.fallback');
          const kind = normalizedArtifactKind(artifact);
          const className = `inline-flex max-w-full items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[12px] dark:border-neutral-800 dark:bg-neutral-950 ${
            navigable
              ? 'hover:border-emerald-300 hover:bg-emerald-50 dark:hover:border-emerald-900 dark:hover:bg-emerald-950/20'
              : ''
          }`;
          const content = (
            <>
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
	                {artifactKindLabel(kind, t)}
              </span>
              <span className="truncate">{label}</span>
            </>
          );
          return navigable ? (
            <button
              key={`${artifact.kind}-${artifact.path || artifact.id || artifact.title || index}`}
              type="button"
              onClick={() => onInspectArtifact(artifact)}
              className={className}
	              title={t('actions.openPath', { path: artifact.path })}
            >
              {content}
            </button>
          ) : (
            <span
              key={`${artifact.kind}-${artifact.path || artifact.id || artifact.title || index}`}
              className={className}
              title={artifact.path || artifact.id || artifact.title || artifact.kind}
            >
              {content}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function normalizedArtifactKind(artifact: NonNullable<TraceRecord['artifacts']>[number]): string {
  if (artifact.path === 'home.md' || artifact.path?.startsWith('wiki/')) return 'wiki_page';
  if (artifact.path?.startsWith('source_cards/')) return 'source_card';
  return artifact.kind;
}

function sourceTypeLabel(type: string, t?: TFunction<'projectWiki'>): string {
  if (type === 'all') return t ? t('sourceTypes.all') : 'All';
  if (type === 'repo') return t ? t('sourceTypes.repo') : 'Repository';
  if (type === 'memory') return t ? t('sourceTypes.memory') : 'Imported memory';
  if (type === 'conversations') return t ? t('sourceTypes.conversations') : 'Conversations';
  if (type === 'knowledge') return t ? t('sourceTypes.knowledge') : 'Knowledge';
  if (type === 'source') return t ? t('sourceTypes.source') : 'Source';
  return type
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function summarizePendingMaintenance(events: MaintenanceEvent[], t: TFunction<'projectWiki'>): string {
  const counts = events.reduce((acc, event) => {
    const key = event.sourceType || 'source';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => t('pendingPage.typeCount', { count, type: sourceTypeLabel(type, t) }))
    .join(', ');
}

function artifactKindLabel(kind: string, t: TFunction<'projectWiki'>): string {
  if (kind === 'wiki_page') return t('artifactKinds.wikiPage');
  if (kind === 'source_card') return t('artifactKinds.sourceCard');
  if (kind === 'context') return t('artifactKinds.context');
  if (kind === 'conflict') return t('artifactKinds.conflict');
  if (kind === 'source') return t('artifactKinds.source');
  return sourceTypeLabel(kind, t);
}

type TraceDecisionInfo = {
  title: string;
  summary?: string;
  items: Array<{ key: string; label: string; meta?: string; detail?: string }>;
};

function describeTraceDecision(trace: TraceRecord, t: TFunction<'projectWiki'>): TraceDecisionInfo | null {
  if (!isRecord(trace.output)) return null;
  if (trace.kind === 'retrieval') {
    if (trace.phase === 'read') {
      const materials = readRecordArray(trace.output.materials);
      const missing = readStringArray(trace.output.missingPaths);
      return {
        title: t('decisions.readMaterials.title'),
        summary: [
          materials.length > 0 ? t('decisions.readMaterials.summary', { count: materials.length }) : t('decisions.readMaterials.empty'),
          missing.length > 0 ? t('decisions.readMaterials.missing', { count: missing.length }) : '',
        ].filter(Boolean).join(' '),
        items: materials.slice(0, 12).map((item, index) => ({
          key: `read-${index}-${readString(item.relativePath)}`,
          label: readString(item.relativePath) || t('decisions.readMaterials.itemFallback', { index: index + 1 }),
          meta: typeof item.chars === 'number' ? t('meta.chars', { count: item.chars }) : undefined,
          detail: readString(item.preview),
        })),
      };
    }
    const selected = readRecordArray(trace.output.selected);
    const toolEvents = readRecordArray(trace.output.toolEvents);
    const needsProjectWiki = typeof trace.output.needsProjectWiki === 'boolean'
      ? trace.output.needsProjectWiki
      : undefined;
    const parts = [
      trace.phase === 'tool_loop_fallback' ? readString(trace.output.reason) : '',
      needsProjectWiki === undefined
        ? ''
        : needsProjectWiki
          ? t('decisions.search.selectedProjectWiki')
          : t('decisions.search.skippedProjectWiki'),
      readString(trace.output.intent) ? t('decisions.search.intent', { intent: readString(trace.output.intent) }) : '',
      trace.phase === 'tool_loop' && toolEvents.length > 0 ? t('decisions.search.toolCalls', { count: toolEvents.length }) : '',
      readString(trace.output.notes),
    ].filter(Boolean);
    return {
      title: trace.phase === 'tool_loop'
        ? t('decisions.search.toolLoopTitle')
        : trace.phase === 'tool_loop_fallback'
          ? t('decisions.search.fallbackTitle')
          : trace.phase === 'tool_catalog_search'
            ? t('decisions.search.toolSearchTitle')
            : t('decisions.search.title'),
      summary: parts.join(' '),
      items: selected.length > 0
        ? selected.slice(0, 12).map((item, index) => ({
          key: `selected-${index}-${readString(item.relativePath)}`,
	          label: readString(item.relativePath) || t('decisions.search.selectedFallback', { index: index + 1 }),
	          meta: typeof item.priority === 'number' ? t('meta.priority', { priority: item.priority }) : undefined,
          detail: readString(item.reason),
        }))
        : toolEvents.slice(0, 12).map((event, index) => ({
          key: `tool-event-${index}-${readString(event.name)}`,
	          label: readString(event.name) || t('decisions.search.toolEventFallback', { index: index + 1 }),
	          meta: event.ok === false ? t('traceStatus.failed') : t('traceStatus.executed'),
          detail: readString(event.preview),
        })),
    };
  }
  if (trace.kind === 'context') {
    const sections = readRecordArray(trace.output.sections);
    const omitted = readRecordArray(trace.output.omitted);
    const contextText = readString(trace.output.context).replace(/\s+/g, ' ');
    const confidence = typeof trace.output.confidence === 'number'
      ? t('quality.confidenceDecimal', { value: trace.output.confidence })
      : '';
    const sectionItems = sections.slice(0, 12).map((section, index) => ({
      key: `section-${index}-${readString(section.title)}`,
	      label: readString(section.title) || t('decisions.context.sectionFallback', { index: index + 1 }),
      meta: readStringArray(section.sourcePaths).join(', '),
      detail: readString(section.content).replace(/\s+/g, ' ').slice(0, 240),
    }));
    const items = sectionItems.length > 0
      ? [
        ...(contextText ? [{
          key: 'context-summary',
	          label: t('decisions.context.summaryLabel'),
          detail: contextText.slice(0, 240),
        }] : []),
        ...sectionItems,
      ]
      : contextText
        ? [{
          key: 'context-pack',
	          label: t('decisions.context.packLabel'),
          detail: contextText.slice(0, 320),
        }]
        : [];
    return {
	      title: t('decisions.context.title'),
	      summary: [
	        contextText ? t('decisions.context.assembled') : '',
	        sections.length > 0 ? t('decisions.context.sections', { count: sections.length }) : '',
	        omitted.length > 0 ? t('decisions.context.omitted', { count: omitted.length }) : '',
        confidence,
      ].filter(Boolean).join(' '),
      items,
    };
  }
  if (trace.kind === 'index') {
    const staleCards = readRecordArray(isRecord(trace.output) ? trace.output.staleCards : undefined);
    if (trace.phase === 'source_freshness') {
      return {
	        title: t('decisions.freshness.title'),
	        summary: staleCards.length > 0
	          ? t('decisions.freshness.markedStale', { count: staleCards.length })
	          : t('decisions.freshness.clean'),
        items: staleCards.slice(0, 12).map((card, index) => ({
          key: `stale-card-${index}-${readString(card.id)}`,
	          label: readString(card.title) || t('decisions.index.sourceCardFallback', { index: index + 1 }),
	          meta: sourceTypeLabel(readString(card.sourceType) || 'source', t),
          detail: readString(card.statusReason),
        })),
      };
    }
    if (trace.phase === 'history_backfill' && isRecord(trace.output)) {
      return {
	        title: t('decisions.history.title'),
	        summary: [
	          t('decisions.history.indexed', { count: readNumber(trace.output.indexedTurns) ?? 0 }),
	          t('decisions.history.skipped', { count: readNumber(trace.output.skippedTurns) ?? 0 }),
	          (readNumber(trace.output.failedTurns) ?? 0) > 0 ? t('decisions.history.failed', { count: readNumber(trace.output.failedTurns) ?? 0 }) : '',
	          t('decisions.history.sourceCards', { count: readNumber(trace.output.sourceCardsCreated) ?? 0 }),
	          t('decisions.history.transcripts', { count: readNumber(trace.output.scannedTranscripts) ?? 0 }),
        ].filter(Boolean).join(' · '),
        items: [
          {
            key: 'history-discovered',
	            label: t('decisions.history.discoveredTurns'),
            detail: String(readNumber(trace.output.discoveredTurns) ?? 0),
          },
        ],
      };
    }
    const cards = readRecordArray(trace.output.cards);
    const skipped = readRecordArray(trace.output.skipped);
    return {
	      title: t('decisions.index.title'),
	      summary: [
	        cards.length > 0 ? t('decisions.index.proposed', { count: cards.length }) : t('decisions.index.noneProposed'),
	        skipped.length > 0 ? t('decisions.index.skipped', { count: skipped.length }) : '',
      ].filter(Boolean).join(' '),
      items: cards.slice(0, 12).map((card, index) => ({
        key: `card-${index}-${readString(card.title)}`,
	        label: readString(card.title) || t('decisions.index.sourceCardFallback', { index: index + 1 }),
	        meta: sourceTypeLabel(readString(card.sourceType) || 'source', t),
        detail: readString(card.description) || readString(card.summary).replace(/\s+/g, ' ').slice(0, 240),
      })),
    };
  }
  if (trace.kind === 'maintain') {
    const pages = readRecordArray(trace.output.pages);
    const conflicts = readRecordArray(trace.output.conflicts);
    const pageItems = pages.slice(0, 12).map((page, index) => ({
      key: `page-${index}-${readString(page.pageId)}`,
	      label: readString(page.title) || readString(page.pageId) || t('decisions.maintain.wikiPageFallback', { index: index + 1 }),
	      meta: wikiPageIdLabel(readString(page.pageId), t),
      detail: readString(page.changeSummary) || readString(page.description),
    }));
    const conflictItems = conflicts.slice(0, 8).map((conflict, index) => ({
      key: `conflict-${index}-${readString(conflict.topic)}`,
	      label: readString(conflict.topic) || t('decisions.maintain.conflictFallback', { index: index + 1 }),
	      meta: t('artifactKinds.conflict'),
      detail: readString(conflict.summary),
    }));
    return {
	      title: t('decisions.maintain.title'),
	      summary: [
	        pages.length > 0 ? t('decisions.maintain.pagesUpdated', { count: pages.length }) : t('decisions.maintain.noPagesUpdated'),
	        conflicts.length > 0 ? t('decisions.maintain.conflictsRecorded', { count: conflicts.length }) : '',
      ].filter(Boolean).join(' '),
      items: [...pageItems, ...conflictItems],
    };
  }
  return null;
}

function StatusPill({ status }: { status: TraceRecord['status'] }) {
  const { t } = useTranslation('projectWiki');
  const className = status === 'success'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
    : status === 'error'
      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${className}`}>
      {statusLabel(status, t)}
    </span>
  );
}

function statusLabel(status: TraceRecord['status'], t: TFunction<'projectWiki'>): string {
  if (status === 'success') return t('traceStatus.success');
  if (status === 'error') return t('traceStatus.error');
  return t('traceStatus.skipped');
}

function sourceStatusLabel(status: string, t: TFunction<'projectWiki'>): string {
  if (status === 'stale') return t('sourceStatus.stale');
  if (status === 'conflict') return t('sourceStatus.conflict');
  if (status === 'draft') return t('sourceStatus.draft');
  return sourceTypeLabel(status, t);
}

function conflictStatusLabel(status: string, t: TFunction<'projectWiki'>): string {
  if (status === 'resolved') return t('conflicts.resolved');
  return t('conflicts.open');
}

function wikiPageIdLabel(pageId: string, t: TFunction<'projectWiki'>): string {
  if (pageId === 'project-overview') return t('wikiPages.projectOverview.title');
  if (pageId === 'project-status') return t('wikiPages.projectStatus.title');
  if (pageId === 'project-feedback') return t('wikiPages.projectFeedback.title');
  if (pageId === 'knowledge') return t('wikiPages.knowledge.title');
  return sourceTypeLabel(pageId, t);
}

function wikiPageDisplayTitle(page: MarkdownItem, t: TFunction<'projectWiki'>): string {
  const pageId = page.pageId || page.relativePath.replace(/^wiki\//, '').replace(/\.md$/, '');
  if (page.relativePath === 'home.md') return t('home.title');
  if (pageId === 'project-overview') return t('wikiPages.projectOverview.title');
  if (pageId === 'project-status') return t('wikiPages.projectStatus.title');
  if (pageId === 'project-feedback') return t('wikiPages.projectFeedback.title');
  if (pageId === 'knowledge') return t('wikiPages.knowledge.title');
  return page.title;
}

function wikiPageDisplayDescription(page: MarkdownItem, t: TFunction<'projectWiki'>): string {
  const pageId = page.pageId || page.relativePath.replace(/^wiki\//, '').replace(/\.md$/, '');
  if (page.relativePath === 'home.md') return t('home.description');
  if (pageId === 'project-overview') return t('wikiPages.projectOverview.description');
  if (pageId === 'project-status') return t('wikiPages.projectStatus.description');
  if (pageId === 'project-feedback') return t('wikiPages.projectFeedback.description');
  if (pageId === 'knowledge') return t('wikiPages.knowledge.description');
  return page.description || '';
}

function TraceBlock({ title, value }: { title: string; value: string }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      <div className="rounded-md border border-neutral-200 p-3 text-[13px] dark:border-neutral-800">
        {value}
      </div>
    </section>
  );
}

function TraceJson({ title, value }: { title: string; value: unknown }) {
  const { t } = useTranslation('projectWiki');
  const json = value === undefined ? t('traces.noData') : JSON.stringify(value, null, 2);
  const size = formatBytes(new TextEncoder().encode(json).length);
  return (
    <details className="group rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
        <span>{title}</span>
        <span className="normal-case tracking-normal text-neutral-400 group-open:hidden">
	          {t('traces.openJson', { size })}
        </span>
        <span className="hidden normal-case tracking-normal text-neutral-400 group-open:inline">
	          {t('traces.hideJson', { size })}
        </span>
      </summary>
      <pre className="max-h-[420px] overflow-auto border-t border-neutral-200 bg-neutral-50 p-3 text-[12px] leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        {json}
      </pre>
    </details>
  );
}

function Markdown({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`${compact ? 'text-[12px]' : 'text-[14px]'} prose max-w-none prose-neutral dark:prose-invert prose-headings:font-semibold prose-pre:bg-neutral-900`}>
      <ReactMarkdown>{stripFrontmatter(content)}</ReactMarkdown>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-[13px] text-neutral-500 dark:text-neutral-400">
      {text}
    </div>
  );
}

function stripFrontmatter(content: string) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  return end >= 0 ? content.slice(end + 4).trimStart() : content;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readRangeLabel(value: unknown): string {
  if (!isRecord(value)) return '';
  const startLine = typeof value.startLine === 'number' ? value.startLine : undefined;
  const endLine = typeof value.endLine === 'number' ? value.endLine : undefined;
  const messageIndex = typeof value.messageIndex === 'number' ? value.messageIndex : undefined;
  if (startLine !== undefined && endLine !== undefined) return `${startLine}-${endLine}`;
  if (startLine !== undefined) return String(startLine);
  if (messageIndex !== undefined) return `message:${messageIndex}`;
  return '';
}

function readString(value: unknown): string {
  if (isRecord(value) && typeof value.preview === 'string') return value.preview.trim();
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}
