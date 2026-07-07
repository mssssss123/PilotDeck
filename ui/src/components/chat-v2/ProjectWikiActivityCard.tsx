import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { ChatMessage } from '../chat/types/types';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { authenticatedFetch } from '../../utils/api';

type ProjectWikiMaterial = {
  relativePath: string;
  title?: string;
  description?: string;
  kind?: string;
  sourceType?: string;
  status?: string;
  reason?: string;
  priority?: number;
  preview?: string;
};

type ProjectWikiActivity = {
  phase?: string;
  query?: string;
  catalog?: ProjectWikiMaterial[];
  selected?: ProjectWikiMaterial[];
  rejected?: ProjectWikiMaterial[];
  read?: ProjectWikiMaterial[];
  events?: ProjectWikiActivityLogEntry[];
  contextPreview?: string;
  contextSections?: Array<{ title?: string; sourcePaths?: string[] }>;
  stats?: {
    catalogCount?: number;
    selectedCount?: number;
    rejectedCount?: number;
    readCount?: number;
    contextSectionCount?: number;
  };
  error?: string;
};

type ProjectWikiActivityLogEntry = {
  id?: string;
  at?: string;
  phase?: string;
  state?: string;
  title?: string;
  detail?: string;
  selectedCount?: number;
  rejectedCount?: number;
  readCount?: number;
};

type ProjectWikiSnapshotResponse = {
  success?: boolean;
  snapshot?: {
    home?: SnapshotFile | null;
    wikiPages?: SnapshotFile[];
    sourceCards?: SnapshotFile[];
  };
};

type SnapshotFile = {
  relativePath?: string;
  title?: string;
  description?: string;
  preview?: string;
  sourceType?: string;
  frontmatter?: Record<string, unknown>;
};

type ProjectWikiFileResponse = {
  success?: boolean;
  file?: {
    relativePath?: string;
    content?: string;
    frontmatter?: Record<string, unknown>;
  };
  error?: string;
};

type MaterialLoadState = {
  path: string;
  loading: boolean;
  content?: string;
  title?: string;
  description?: string;
  status?: string;
  kind?: string;
  sourceType?: string;
  reason?: string;
  frontmatter?: Record<string, unknown>;
  error?: string;
};

type ProjectWikiActivityCardProps = {
  activityMessage: ChatMessage | null;
  projectPath?: string;
  pending?: boolean;
};

type ConstellationNode = {
  id: string;
  x: number;
  y: number;
  size: number;
  label: string;
  material?: ProjectWikiMaterial;
  nodeType: 'home' | 'wiki' | 'source' | 'ghost';
  state: 'idle' | 'candidate' | 'selected' | 'read' | 'rejected' | 'stale' | 'ghost';
  showLabel: boolean;
};

const MAX_SNAPSHOT_SOURCE_CARDS = 32;

export default function ProjectWikiActivityCard({
  activityMessage,
  projectPath,
  pending = false,
}: ProjectWikiActivityCardProps) {
  const { t } = useTranslation('chat');
  const activity = normalizeProjectWikiActivity(activityMessage?.projectWiki);
  const state = pending ? 'running' : String(activityMessage?.state || 'running');
  const isRunning = state === 'running';
  const isFailed = state === 'failed';
  const isSkipped = state === 'skipped';
  const userTouchedExpandedRef = useRef(false);
  const [expanded, setExpanded] = useState(() => isRunning);
  const [snapshotMaterials, setSnapshotMaterials] = useState<ProjectWikiMaterial[]>([]);
  const [openMaterial, setOpenMaterial] = useState<MaterialLoadState | null>(null);

  const selected = activity.selected ?? [];
  const rejected = activity.rejected ?? [];
  const read = activity.read ?? [];
  const eventCatalog = activity.catalog ?? [];
  const events = activity.events ?? [];
  const catalog = eventCatalog.length > 0 ? eventCatalog : snapshotMaterials;
  const allMaterials = mergeMaterials(catalog, selected, read, rejected);
  const selectedCount = activity.stats?.selectedCount ?? selected.length;
  const catalogCount = activity.stats?.catalogCount ?? allMaterials.length;
  const readCount = activity.stats?.readCount ?? read.length;
  const contextCount = activity.stats?.contextSectionCount ?? activity.contextSections?.length ?? 0;
  const summary = makeSummary({
    t,
    isRunning,
    isFailed,
    isSkipped,
    pending,
    selectedCount,
    catalogCount,
    readCount,
    contextCount,
    detail: activityMessage?.detail || activity.query,
  });

  useEffect(() => {
    if (userTouchedExpandedRef.current) return;
    setExpanded(isRunning);
  }, [isRunning]);

  useEffect(() => {
    if (!projectPath || eventCatalog.length > 0 || snapshotMaterials.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ projectPath, traceLimit: '1' });
        const response = await authenticatedFetch(`/api/project-wiki/snapshot?${params.toString()}`);
        if (!response.ok) return;
        const data = await response.json() as ProjectWikiSnapshotResponse;
        if (cancelled || data.success === false || !data.snapshot) return;
        setSnapshotMaterials(snapshotToMaterials(data.snapshot));
      } catch {
        // The live backend events will still populate the graph when available.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventCatalog.length, projectPath, snapshotMaterials.length]);

  const handleToggleExpanded = () => {
    userTouchedExpandedRef.current = true;
    setExpanded((value) => !value);
  };

  const loadMaterial = async (material: ProjectWikiMaterial | undefined) => {
    if (!material?.relativePath || !projectPath || material.kind === 'ghost') return;
    setOpenMaterial({
      path: material.relativePath,
      title: material.title || material.relativePath,
      reason: material.reason,
      loading: true,
    });
    try {
      const params = new URLSearchParams({
        projectPath,
        path: material.relativePath,
      });
      const response = await authenticatedFetch(`/api/project-wiki/file?${params.toString()}`);
      const data = await response.json() as ProjectWikiFileResponse;
      if (!response.ok || data.success === false || !data.file) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setOpenMaterial({
        path: material.relativePath,
        title: material.title || readFrontmatterTitle(data.file.frontmatter) || data.file.relativePath || material.relativePath,
        description: material.description,
        status: material.status || readString(data.file.frontmatter?.status),
        kind: material.kind,
        sourceType: material.sourceType || readString(data.file.frontmatter?.sourceType),
        reason: material.reason,
        frontmatter: data.file.frontmatter,
        loading: false,
        content: stripProjectWikiFrontmatter(data.file.content || ''),
      });
    } catch (error) {
      setOpenMaterial({
        path: material.relativePath,
        title: material.title || material.relativePath,
        reason: material.reason,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!pending && !activityMessage) return null;

  return (
    <div className="mb-3 text-[14px] leading-relaxed text-neutral-500 dark:text-neutral-400">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={handleToggleExpanded}
        className="group flex min-w-0 max-w-full items-center gap-2 text-left transition hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        )}
        <BookOpen className={`h-4 w-4 shrink-0 ${isRunning ? 'text-emerald-600 dark:text-emerald-300' : 'text-neutral-400 dark:text-neutral-500'}`} strokeWidth={1.9} />
        <span className="shrink-0 font-semibold text-neutral-700 dark:text-neutral-300">
          {t('projectWiki.title', { defaultValue: 'ProjectWiki' })}
        </span>
        <span className="min-w-0 truncate text-[13px] text-neutral-400 dark:text-neutral-500">
          {summary}
        </span>
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-500 dark:text-emerald-300" />
        ) : isFailed ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-300" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-300" />
        )}
      </button>

      {expanded ? (
        <div className="mt-2 ml-5 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
          <ConstellationCanvas
            materials={allMaterials}
            selected={selected}
            rejected={rejected}
            read={read}
            phase={activity.phase}
            events={events}
            isRunning={isRunning}
            onOpenMaterial={loadMaterial}
          />

          <ProjectWikiEventRail
            events={events}
            pending={pending}
            currentPhase={activity.phase}
            isRunning={isRunning}
          />

          <div className="border-t border-neutral-100 px-3 py-2 dark:border-neutral-900">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              <InfoPill label={t('projectWiki.catalogCount', {
                count: catalogCount,
                defaultValue: '{{count}} available',
              })} />
              <InfoPill tone="green" label={t('projectWiki.selectedCount', {
                count: selectedCount,
                defaultValue: '{{count}} selected',
              })} />
              <InfoPill label={t('projectWiki.readCount', {
                count: readCount,
                defaultValue: '{{count}} read',
              })} />
              {contextCount > 0 ? (
                <InfoPill tone="green" label={t('projectWiki.contextSectionsCount', {
                  count: contextCount,
                  defaultValue: '{{count}} context sections',
                })} />
              ) : null}
            </div>
          </div>

          {openMaterial ? (
            <MaterialPreview material={openMaterial} onClose={() => setOpenMaterial(null)} />
          ) : null}

          {activity.contextPreview ? (
            <div className="border-t border-neutral-100 px-3 py-3 dark:border-neutral-900">
              <div className="mb-1 text-[12px] font-semibold text-neutral-600 dark:text-neutral-300">
                {t('projectWiki.contextPreview', { defaultValue: 'Context sent to the main agent' })}
              </div>
              <div className="max-h-[160px] overflow-auto rounded-lg bg-neutral-50 p-3 text-[12px] leading-5 text-neutral-600 dark:bg-neutral-900/70 dark:text-neutral-300">
                {activity.contextPreview}
              </div>
            </div>
          ) : null}

          {activity.error ? (
            <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {activity.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConstellationCanvas({
  materials,
  selected,
  rejected,
  read,
  phase,
  events,
  isRunning,
  onOpenMaterial,
}: {
  materials: ProjectWikiMaterial[];
  selected: ProjectWikiMaterial[];
  rejected: ProjectWikiMaterial[];
  read: ProjectWikiMaterial[];
  phase?: string;
  events: ProjectWikiActivityLogEntry[];
  isRunning: boolean;
  onOpenMaterial: (material: ProjectWikiMaterial | undefined) => void;
}) {
  const nodes = useMemo(
    () => buildConstellationNodes(materials, selected, rejected, read, phase, isRunning),
    [isRunning, materials, phase, read, rejected, selected],
  );
  const center = nodes.find((node) => node.nodeType === 'home') ?? nodes[0];
  const selectedNodes = nodes.filter((node) => node.state === 'selected' || node.state === 'read');
  const wikiNodes = nodes.filter((node) => node.nodeType === 'wiki');

  return (
    <div className="relative h-[260px] overflow-hidden bg-[radial-gradient(circle_at_50%_45%,rgba(16,185,129,0.08),transparent_34%),linear-gradient(180deg,#fff,#fafafa)] dark:bg-[radial-gradient(circle_at_50%_45%,rgba(16,185,129,0.12),transparent_34%),linear-gradient(180deg,#0a0a0a,#050505)]">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <circle cx="50" cy="50" r="18" fill="none" stroke="rgba(16,185,129,0.10)" strokeWidth="0.35" />
        <circle cx="50" cy="50" r="34" fill="none" stroke="rgba(115,115,115,0.12)" strokeWidth="0.28" strokeDasharray="1.8 2.4" />
        {center ? wikiNodes.map((node) => (
          <line
            key={`wiki-${node.id}`}
            x1={center.x}
            y1={center.y}
            x2={node.x}
            y2={node.y}
            stroke="rgba(115,115,115,0.18)"
            strokeWidth="0.35"
          />
        )) : null}
        {center ? selectedNodes.map((node) => (
          <line
            key={`selected-${node.id}`}
            x1={center.x}
            y1={center.y}
            x2={node.x}
            y2={node.y}
            stroke="rgba(16,185,129,0.55)"
            strokeWidth="0.55"
            strokeLinecap="round"
          />
        )) : null}
      </svg>

      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          disabled={!node.material?.relativePath || node.nodeType === 'ghost'}
          onClick={() => onOpenMaterial(node.material)}
          className="group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 disabled:cursor-default"
          style={{ left: `${node.x}%`, top: `${node.y}%` }}
          title={node.material?.relativePath || node.label}
        >
          <span className={`relative flex items-center justify-center rounded-full transition ${
            node.state === 'selected'
              ? 'bg-emerald-500 shadow-[0_0_0_5px_rgba(16,185,129,0.16),0_0_18px_rgba(16,185,129,0.55)]'
              : node.state === 'read'
                ? 'bg-emerald-400 shadow-[0_0_0_4px_rgba(16,185,129,0.13)]'
                : node.state === 'candidate'
                  ? 'bg-neutral-500 shadow-[0_0_0_4px_rgba(115,115,115,0.12)] dark:bg-neutral-300'
                  : node.state === 'rejected'
                    ? 'bg-neutral-300 opacity-35 dark:bg-neutral-700'
                    : node.state === 'stale'
                      ? 'bg-amber-400 shadow-[0_0_0_4px_rgba(245,158,11,0.16)]'
                      : node.state === 'ghost'
                        ? 'animate-pulse bg-neutral-200 dark:bg-neutral-800'
                        : 'bg-neutral-400 dark:bg-neutral-600'
          }`}
          style={{ width: node.size, height: node.size }}
          >
            {node.state === 'candidate' && isRunning ? (
              <span className="absolute inset-[-6px] animate-ping rounded-full border border-emerald-300/60" />
            ) : null}
            {node.nodeType === 'home' ? (
              <BookOpen className="h-3.5 w-3.5 text-white" strokeWidth={2} />
            ) : node.nodeType === 'wiki' ? (
              <FileText className="h-3 w-3 text-white" strokeWidth={2} />
            ) : node.state === 'ghost' ? null : (
              <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
            )}
          </span>
          {node.showLabel ? (
            <span className={`max-w-[120px] truncate rounded-md px-1.5 py-0.5 text-[10px] leading-4 shadow-sm ${
              node.state === 'selected' || node.state === 'read'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
                : 'bg-white/90 text-neutral-500 dark:bg-neutral-900/90 dark:text-neutral-400'
            }`}>
              {node.label}
            </span>
          ) : null}
        </button>
      ))}

      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-white/80 px-2 py-1 text-[11px] font-medium text-neutral-500 shadow-sm dark:bg-neutral-950/80 dark:text-neutral-400">
        <Sparkles className={`h-3 w-3 ${isRunning ? 'animate-pulse text-emerald-500' : 'text-neutral-400'}`} />
        {formatPhaseLabel(phase, events)}
      </div>
    </div>
  );
}

function ProjectWikiEventRail({
  events,
  pending,
  currentPhase,
  isRunning,
}: {
  events: ProjectWikiActivityLogEntry[];
  pending: boolean;
  currentPhase?: string;
  isRunning: boolean;
}) {
  const { t } = useTranslation('chat');
  const visibleEvents = events.length > 0
    ? events.slice(-5)
    : [{
        id: 'opening',
        phase: currentPhase || 'started',
        state: isRunning ? 'running' : 'completed',
        title: pending
          ? t('projectWiki.events.opening', { defaultValue: 'Opening ProjectWiki resources' })
          : t('projectWiki.events.waiting', { defaultValue: 'Waiting for ProjectWiki activity' }),
        detail: '',
      }];
  return (
    <div className="border-t border-neutral-100 bg-white px-3 py-2.5 dark:border-neutral-900 dark:bg-neutral-950">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
        <Sparkles className={`h-3 w-3 ${isRunning ? 'animate-pulse text-emerald-500' : 'text-neutral-400'}`} />
        {t('projectWiki.events.title', { defaultValue: 'Model path' })}
      </div>
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {visibleEvents.map((event, index) => {
          const running = event.state === 'running' && index === visibleEvents.length - 1 && isRunning;
          return (
            <div
              key={event.id || `${event.phase}-${index}`}
              className={`min-w-[168px] max-w-[220px] rounded-lg border px-2.5 py-2 ${
                running
                  ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'
                  : 'border-neutral-200 bg-neutral-50/70 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-300'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
                <span className="truncate text-[11px] font-semibold">{event.title || event.phase || 'ProjectWiki'}</span>
              </div>
              {event.detail ? (
                <div className="mt-1 line-clamp-2 text-[10px] leading-4 opacity-75">
                  {event.detail}
                </div>
              ) : null}
              {event.selectedCount || event.readCount || event.rejectedCount ? (
                <div className="mt-1 flex gap-1 text-[10px] opacity-70">
                  {event.selectedCount ? (
                    <span>{t('projectWiki.events.selectedCount', {
                      count: event.selectedCount,
                      defaultValue: '{{count}} selected',
                    })}</span>
                  ) : null}
                  {event.readCount ? (
                    <span>{t('projectWiki.events.readCount', {
                      count: event.readCount,
                      defaultValue: '{{count}} read',
                    })}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MaterialPreview({
  material,
  onClose,
}: {
  material: MaterialLoadState;
  onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div className="border-t border-neutral-100 bg-neutral-50/60 px-3 py-3 dark:border-neutral-900 dark:bg-neutral-950">
      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[15px] font-semibold text-neutral-950 dark:text-neutral-50">
                {material.title || material.path}
              </span>
              <MaterialBadge label={material.sourceType || material.kind || t('projectWiki.material.kind', { defaultValue: 'Wiki' })} />
              {material.status ? <MaterialBadge tone={material.status === 'active' ? 'green' : 'amber'} label={material.status} /> : null}
            </div>
            <div className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">
              {material.path}
            </div>
            {material.description ? (
              <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-neutral-500 dark:text-neutral-400">
                {material.description}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
            onClick={onClose}
          >
            {t('projectWiki.closeMaterial', { defaultValue: 'Close' })}
          </button>
        </div>

        {material.reason ? (
          <div className="mb-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[12px] leading-5 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
            <div className="mb-0.5 font-semibold">{t('projectWiki.reason', { defaultValue: 'Reason' })}</div>
            {material.reason}
          </div>
        ) : null}

        {material.loading ? (
          <div className="flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-4 text-[12px] text-neutral-500 dark:bg-neutral-900/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('projectWiki.loadingMaterial', { defaultValue: 'Loading material...' })}
          </div>
        ) : material.error ? (
          <div className="rounded-lg bg-red-50 p-3 text-[12px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {t('projectWiki.materialFailed', { defaultValue: 'Could not load material' })}: {material.error}
          </div>
        ) : (
          <div className="max-h-[360px] overflow-auto rounded-lg border border-neutral-100 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
            <Markdown className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-headings:mb-2 prose-headings:mt-3 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-pre:my-3">
              {material.content || ''}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function MaterialBadge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'green' | 'amber';
}) {
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
      tone === 'green'
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
        : tone === 'amber'
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400'
    }`}>
      {label}
    </span>
  );
}

function buildConstellationNodes(
  materials: ProjectWikiMaterial[],
  selected: ProjectWikiMaterial[],
  rejected: ProjectWikiMaterial[],
  read: ProjectWikiMaterial[],
  phase: string | undefined,
  isRunning: boolean,
): ConstellationNode[] {
  if (materials.length === 0) {
    return Array.from({ length: 12 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 12 - Math.PI / 2;
      const radius = index % 3 === 0 ? 30 : 38;
      return {
        id: `ghost-${index}`,
        x: 50 + Math.cos(angle) * radius,
        y: 50 + Math.sin(angle) * radius * 0.58,
        size: index === 0 ? 14 : 8,
        label: '',
        nodeType: 'ghost',
        state: 'ghost',
        showLabel: false,
      };
    });
  }

  const selectedByPath = new Map(selected.map((item) => [item.relativePath, item]));
  const rejectedByPath = new Map(rejected.map((item) => [item.relativePath, item]));
  const readByPath = new Map(read.map((item) => [item.relativePath, item]));
  const sourceCards = materials
    .filter((material) => material.relativePath !== 'home.md' && !material.relativePath.startsWith('wiki/'))
    .slice(0, MAX_SNAPSHOT_SOURCE_CARDS);
  const wikiPages = materials.filter((material) => material.relativePath.startsWith('wiki/')).slice(0, 8);
  const home = materials.find((material) => material.relativePath === 'home.md');
  const nodes: ConstellationNode[] = [];

  if (home) {
    nodes.push(materialToNode(home, 50, 50, 22, 'home', selectedByPath, rejectedByPath, readByPath, phase, isRunning, true));
  }

  const wikiAngles = [-95, -18, 62, 145, -145, 18, 100, -60];
  wikiPages.forEach((material, index) => {
    const angle = (wikiAngles[index % wikiAngles.length] * Math.PI) / 180;
    const radius = index < 4 ? 25 : 34;
    nodes.push(materialToNode(
      material,
      50 + Math.cos(angle) * radius,
      50 + Math.sin(angle) * radius * 0.68,
      17,
      'wiki',
      selectedByPath,
      rejectedByPath,
      readByPath,
      phase,
      isRunning,
      true,
    ));
  });

  const clusters: Record<string, { x: number; y: number }> = {
    repo: { x: 22, y: 71 },
    conversations: { x: 78, y: 31 },
    knowledge: { x: 76, y: 72 },
    memory: { x: 24, y: 31 },
    unknown: { x: 50, y: 82 },
  };
  const byCluster = new Map<string, ProjectWikiMaterial[]>();
  for (const material of sourceCards) {
    const cluster = material.sourceType || material.kind || 'unknown';
    const key = clusters[cluster] ? cluster : 'unknown';
    const group = byCluster.get(key) || [];
    group.push(material);
    byCluster.set(key, group);
  }

  for (const [cluster, group] of byCluster) {
    const center = clusters[cluster] || clusters.unknown;
    group.forEach((material, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, group.length) - Math.PI / 2;
      const ring = group.length < 5 ? 8 : index % 2 === 0 ? 8 : 14;
      nodes.push(materialToNode(
        material,
        center.x + Math.cos(angle) * ring,
        center.y + Math.sin(angle) * ring * 0.65,
        9,
        'source',
        selectedByPath,
        rejectedByPath,
        readByPath,
        phase,
        isRunning,
        selectedByPath.has(material.relativePath) || readByPath.has(material.relativePath),
      ));
    });
  }

  return nodes;
}

function materialToNode(
  material: ProjectWikiMaterial,
  x: number,
  y: number,
  size: number,
  nodeType: ConstellationNode['nodeType'],
  selectedByPath: Map<string, ProjectWikiMaterial>,
  rejectedByPath: Map<string, ProjectWikiMaterial>,
  readByPath: Map<string, ProjectWikiMaterial>,
  phase: string | undefined,
  isRunning: boolean,
  showLabel: boolean,
): ConstellationNode {
  const selected = selectedByPath.get(material.relativePath);
  const rejected = rejectedByPath.get(material.relativePath);
  const read = readByPath.get(material.relativePath);
  const merged = selected || read || rejected || material;
  let state: ConstellationNode['state'] = 'idle';
  if (selected) state = 'selected';
  else if (read) state = 'read';
  else if (rejected) state = 'rejected';
  else if (material.status === 'stale' || material.status === 'conflict') state = 'stale';
  else if (isRunning && ['catalog', 'retriever', 'search', 'selected', 'read', 'curator'].includes(String(phase || ''))) state = 'candidate';
  return {
    id: material.relativePath,
    x: clamp(x, 7, 93),
    y: clamp(y, 12, 88),
    size: selected ? size + 4 : read ? size + 2 : size,
    label: merged.title || basename(material.relativePath),
    material: merged,
    nodeType,
    state,
    showLabel,
  };
}

function mergeMaterials(...groups: ProjectWikiMaterial[][]): ProjectWikiMaterial[] {
  const byPath = new Map<string, ProjectWikiMaterial>();
  for (const group of groups) {
    for (const material of group) {
      if (!material.relativePath) continue;
      byPath.set(material.relativePath, {
        ...(byPath.get(material.relativePath) || {}),
        ...material,
      });
    }
  }
  return Array.from(byPath.values());
}

function snapshotToMaterials(snapshot: NonNullable<ProjectWikiSnapshotResponse['snapshot']>): ProjectWikiMaterial[] {
  const materials: ProjectWikiMaterial[] = [];
  if (snapshot.home?.relativePath) {
    materials.push(snapshotFileToMaterial(snapshot.home, 'home'));
  }
  for (const page of snapshot.wikiPages ?? []) {
    if (page.relativePath) materials.push(snapshotFileToMaterial(page, 'wiki'));
  }
  for (const card of (snapshot.sourceCards ?? []).slice(0, MAX_SNAPSHOT_SOURCE_CARDS)) {
    if (card.relativePath) materials.push(snapshotFileToMaterial(card, 'source_card'));
  }
  return materials;
}

function snapshotFileToMaterial(file: SnapshotFile, kind: string): ProjectWikiMaterial {
  return {
    relativePath: file.relativePath || '',
    title: file.title,
    description: file.description,
    preview: file.preview,
    kind,
    sourceType: file.sourceType || readString(file.frontmatter?.sourceType),
    status: readString(file.frontmatter?.status),
  };
}

function normalizeProjectWikiActivity(value: unknown): ProjectWikiActivity {
  if (!value || typeof value !== 'object') return {};
  return value as ProjectWikiActivity;
}

function makeSummary({
  t,
  isRunning,
  isFailed,
  isSkipped,
  pending,
  selectedCount,
  catalogCount,
  readCount,
  contextCount,
  detail,
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
  isRunning: boolean;
  isFailed: boolean;
  isSkipped: boolean;
  pending: boolean;
  selectedCount: number;
  catalogCount: number;
  readCount: number;
  contextCount: number;
  detail?: string;
}) {
  if (isFailed) return t('projectWiki.summary.failed', { defaultValue: 'preparation failed' });
  if (isSkipped) return t('projectWiki.summary.skipped', { defaultValue: 'not needed for this turn' });
  if (pending) return t('projectWiki.summary.opening', { defaultValue: 'opening project memory...' });
  if (isRunning) {
    if (selectedCount > 0) {
      return t('projectWiki.summary.runningSelected', {
        selected: selectedCount,
        catalog: catalogCount,
        defaultValue: 'exploring {{catalog}} resources · {{selected}} selected',
      });
    }
    return detail || t('projectWiki.summary.running', {
      catalog: catalogCount,
      defaultValue: 'exploring {{catalog}} resources',
    });
  }
  if (contextCount > 0) {
    return t('projectWiki.summary.completed', {
      sections: contextCount,
      selected: selectedCount,
      defaultValue: 'assembled {{sections}} context sections · {{selected}} selected',
    });
  }
  return t('projectWiki.summary.completedNoContext', {
    selected: selectedCount,
    read: readCount,
    defaultValue: '{{selected}} selected · {{read}} read',
  });
}

function InfoPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'green';
}) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-1 ${
      tone === 'green'
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200'
        : 'bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400'
    }`}>
      {label}
    </span>
  );
}

function readFrontmatterTitle(frontmatter: Record<string, unknown> | undefined): string | undefined {
  const value = frontmatter?.title;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stripProjectWikiFrontmatter(content: string): string {
  const trimmed = content.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return content;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(trimmed);
  if (!match) return content;
  const body = trimmed.slice(match[0].length).trimStart();
  return body || content;
}

function formatPhaseLabel(phase: string | undefined, events: ProjectWikiActivityLogEntry[]): string {
  const latest = events[events.length - 1];
  if (latest?.title) return latest.title;
  switch (phase) {
    case 'retriever':
      return 'Retriever';
    case 'search':
      return 'Searcher';
    case 'curator':
      return 'Curator';
    case 'assembled':
      return 'Context assembled';
    default:
      return 'ProjectWiki map';
  }
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
