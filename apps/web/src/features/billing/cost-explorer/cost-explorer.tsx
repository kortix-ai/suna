'use client';

import { Fragment } from 'react';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { resolvePreset, type CostRange, type CostRangePreset } from '@/components/ui/date-range-picker';
import { useCostSummary } from '@/hooks/billing/use-cost-explorer';
import { useSessionCostDetail, useSessionCostProjects } from '@/hooks/billing/use-session-costs';

import { CostLevelShell } from './cost-level-shell';
import { ProjectsLevel } from './projects-level';
import { SessionsLevel } from './sessions-level';
import { SessionCostDetailContent } from '../session-cost-detail';

/** The whole explorer's default landing preset — matches `DEFAULT_RANGE_PRESET`
 *  in `projects-level.tsx`'s own `onResetRange`. Kept as a second literal
 *  (not a shared import) because the two callers reset to it independently:
 *  this one decides what the URL omits, that one decides what a "Reset
 *  range" click resolves to. Same value, deliberately un-shared. */
const DEFAULT_RANGE_PRESET: Exclude<CostRangePreset, 'custom'> = '30d';

const RESOLVABLE_PRESETS: readonly Exclude<CostRangePreset, 'custom'>[] = ['24h', '7d', '30d', '90d'];

function isResolvablePreset(value: string): value is Exclude<CostRangePreset, 'custom'> {
  return (RESOLVABLE_PRESETS as readonly string[]).includes(value);
}

/** The explorer's whole URL-addressable state: the shared date window plus
 *  which level of Project -> Sessions -> Session is showing. */
export interface ExplorerState {
  range: CostRange;
  projectId: string | null;
  sessionId: string | null;
}

/**
 * Reads the explorer's level and range off the URL. Pure — takes the raw
 * `URLSearchParams` the caller already has (from `useSearchParams()`), no
 * Next.js hooks of its own, so it is testable without a router.
 *
 * A named preset (`24h`/`7d`/`30d`/`90d`) is re-resolved against "now" at
 * parse time — the window is relative to when the link is opened, not frozen
 * at the moment it was shared. A `custom` range instead carries its own
 * explicit `from`/`to`, since there is no preset to re-derive it from.
 *
 * Guard: a `session` without a `project` is ignored. Level 3 (the session
 * ledger) has no way to resolve its parent breadcrumb crumb without a
 * project id, so a URL edited (or bookmarked) into that half-formed shape
 * falls back to level 1 instead of rendering broken.
 */
export function parseExplorerState(params: URLSearchParams): ExplorerState {
  const rawRange = params.get('range');
  let range: CostRange;
  if (rawRange === 'custom') {
    const from = params.get('from');
    const to = params.get('to');
    range =
      from && to
        ? { preset: 'custom', from, to }
        : resolvePreset(DEFAULT_RANGE_PRESET, new Date());
  } else if (rawRange && isResolvablePreset(rawRange)) {
    range = resolvePreset(rawRange, new Date());
  } else {
    range = resolvePreset(DEFAULT_RANGE_PRESET, new Date());
  }

  const projectId = params.get('project');
  const rawSessionId = params.get('session');
  const sessionId = projectId && rawSessionId ? rawSessionId : null;

  return { range, projectId, sessionId };
}

/**
 * The inverse of `parseExplorerState`. Omits the default `30d` preset and
 * any null level, so the common case — landing on the explorer with no
 * drill-down and no custom window — keeps the URL exactly as clean as it was
 * before this state existed (`?tab=transactions`, no explorer params at
 * all). Defensively drops a `session` with no `project` too, mirroring the
 * parse-side guard, so the two stay symmetric even if a caller ever
 * constructs a malformed state directly.
 */
export function serializeExplorerState(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.range.preset !== DEFAULT_RANGE_PRESET) {
    params.set('range', state.range.preset);
    if (state.range.preset === 'custom') {
      params.set('from', state.range.from);
      params.set('to', state.range.to);
    }
  }

  if (state.projectId) {
    params.set('project', state.projectId);
    if (state.sessionId) params.set('session', state.sessionId);
  }

  return params;
}

/** The URL keys this component owns. Cleared before every push so a stale
 *  `range`/`from`/`to`/`project`/`session` from the previous state can never
 *  survive next to the freshly serialized ones — `serializeExplorerState` is
 *  additive (it only ever sets keys), so something has to delete first. */
const EXPLORER_PARAM_KEYS = ['range', 'from', 'to', 'project', 'session'] as const;

export interface ExplorerCrumb {
  key: 'usage' | 'project' | 'session';
  label: string;
  /** True for the crumb representing the level currently showing — rendered
   *  as static text, not a click target (there is nothing deeper to clear). */
  current: boolean;
  /** The state a click on this crumb pushes. Equal to the crumb's own level
   *  for the current crumb (a no-op), and one level shallower — with the
   *  active range preserved — for every crumb above it. */
  target: ExplorerState;
}

/**
 * The pure breadcrumb model behind `Usage › <project> › <session prefix>`.
 * Kept separate from rendering so "does clicking a crumb clear the right
 * things" is a plain object assertion, not a DOM interaction — this
 * codebase's tests render everything via `renderToStaticMarkup`, which
 * cannot fire a click.
 */
export function buildBreadcrumbCrumbs(
  state: ExplorerState,
  projectLabel: string | null,
): ExplorerCrumb[] {
  const crumbs: ExplorerCrumb[] = [
    {
      key: 'usage',
      label: 'Usage',
      current: state.projectId === null,
      target: { range: state.range, projectId: null, sessionId: null },
    },
  ];

  if (state.projectId) {
    crumbs.push({
      key: 'project',
      label: projectLabel ?? state.projectId.slice(0, 9),
      current: state.sessionId === null,
      target: { range: state.range, projectId: state.projectId, sessionId: null },
    });
  }

  if (state.projectId && state.sessionId) {
    crumbs.push({
      key: 'session',
      label: state.sessionId.slice(0, 9),
      current: true,
      target: { range: state.range, projectId: state.projectId, sessionId: state.sessionId },
    });
  }

  return crumbs;
}

/**
 * Level 3 — a single session's cost ledger. Reuses `SessionCostDetailContent`
 * (built for the old modal) as the shell's body, with the chart hidden: a
 * day-bucketed spend trend for one session carries no information a single
 * bar wouldn't already show. The range control above still drives the
 * tiles/model list, scoped to this one session via `useCostSummary`'s
 * `sessionId` input — the ledger table itself is not window-filtered (it has
 * no `from`/`to` of its own; see `useSessionCostDetail`), so it always shows
 * every finalized entry regardless of the selected window.
 */
function SessionLedgerLevel({
  projectId,
  sessionId,
  range,
  onRangeChange,
}: {
  projectId: string;
  sessionId: string;
  range: CostRange;
  onRangeChange: (next: CostRange) => void;
}) {
  const summaryQuery = useCostSummary({ projectId, sessionId, from: range.from, to: range.to });
  const detailQuery = useSessionCostDetail({ projectId, sessionId });

  return (
    <CostLevelShell
      range={range}
      onRangeChange={onRangeChange}
      summary={summaryQuery.data}
      isSummaryLoading={summaryQuery.isLoading}
      summaryError={summaryQuery.error instanceof Error ? summaryQuery.error : null}
      showChart={false}
    >
      <SessionCostDetailContent
        detail={detailQuery.data}
        isLoading={detailQuery.isLoading}
        error={detailQuery.error instanceof Error ? detailQuery.error : null}
      />
    </CostLevelShell>
  );
}

/**
 * The Project -> Sessions -> Session cost drill-down. Owns no data itself —
 * each level (`ProjectsLevel`, `SessionsLevel`, `SessionLedgerLevel`) fetches
 * its own — this component owns only the URL-addressable state (level +
 * date window) and the breadcrumb that walks it.
 *
 * State lives in the URL, not `useState`, so the browser back button walks
 * back up the hierarchy one level at a time and a mid-drill-down link is
 * shareable. Every push clears this component's own keys first
 * (`EXPLORER_PARAM_KEYS`) and re-applies `serializeExplorerState`'s output on
 * top of the *current* search string, so an unrelated param already on the
 * URL (this page's own `?tab=transactions`) survives untouched.
 */
export function CostExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = parseExplorerState(searchParams);

  const projectsQuery = useSessionCostProjects();
  const projectLabel =
    projectsQuery.data?.find((project) => project.project_id === state.projectId)?.name ?? null;

  const pushState = (next: ExplorerState) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of EXPLORER_PARAM_KEYS) params.delete(key);
    for (const [key, value] of serializeExplorerState(next)) params.set(key, value);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const handleRangeChange = (range: CostRange) => pushState({ ...state, range });
  const handleSelectProject = (projectId: string) =>
    pushState({ range: state.range, projectId, sessionId: null });
  const handleSelectSession = (sessionId: string) => pushState({ ...state, sessionId });

  const crumbs = buildBreadcrumbCrumbs(state, projectLabel);

  return (
    <div className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.key}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem>
                {crumb.current ? (
                  <BreadcrumbPage className={crumb.key === 'session' ? 'font-mono text-xs' : undefined}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button type="button" className="cursor-pointer" onClick={() => pushState(crumb.target)}>
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      {state.projectId && state.sessionId ? (
        <SessionLedgerLevel
          projectId={state.projectId}
          sessionId={state.sessionId}
          range={state.range}
          onRangeChange={handleRangeChange}
        />
      ) : state.projectId ? (
        <SessionsLevel
          projectId={state.projectId}
          range={state.range}
          onRangeChange={handleRangeChange}
          onSelectSession={handleSelectSession}
        />
      ) : (
        <ProjectsLevel
          range={state.range}
          onRangeChange={handleRangeChange}
          onSelectProject={handleSelectProject}
        />
      )}
    </div>
  );
}
