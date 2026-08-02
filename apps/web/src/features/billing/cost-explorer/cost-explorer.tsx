'use client';

import { Fragment, useState } from 'react';

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
 * `URLSearchParams` the caller already has (from `useSearchParams()`) plus the
 * instant a preset resolves against, and reads no ambient state of its own
 * (no Next.js hooks, no clock), so it is testable without a router and its
 * output is a function of its inputs alone.
 *
 * `now` is a required parameter, not a `new Date()` default, deliberately.
 * This function runs in a render body; a default would let a caller re-read
 * the clock on every render, and both bounds it returns land inside four React
 * Query keys. A window that moves by a millisecond per render mints a new key
 * per render, and since no cost query carries `placeholderData`, every new key
 * is a cache miss that fetches — and that fetch re-renders, so it does not
 * settle. Request count then grows linearly with time on the page for as long
 * as the tab is open.
 *
 * Unbounded is the claim; a rate is not. The one bound that holds everywhere is
 * `Date`'s 1 ms resolution — two renders inside the same millisecond produce an
 * identical `to` and no new key — so no environment exceeds ~1000 cycles/s. The
 * rate in a browser has NOT been measured and no mechanism for it is asserted
 * here. Note the cycle is not gated on responses: react-query notifies when a
 * fetch STARTS, so a slow endpoint does not slow the loop down.
 * `useExplorerClockAnchor` below is what supplies a `now` that holds still.
 *
 * A named preset (`24h`/`7d`/`30d`/`90d`) is resolved against `now` — the
 * window is relative to when the link is opened, not frozen at the moment it
 * was shared. A `custom` range instead carries its own explicit `from`/`to`,
 * so it never consults `now` at all and was always stable.
 *
 * Guard: a `session` without a `project` is ignored. Level 3 (the session
 * ledger) has no way to resolve its parent breadcrumb crumb without a
 * project id, so a URL edited (or bookmarked) into that half-formed shape
 * falls back to level 1 instead of rendering broken.
 */
export function parseExplorerState(params: URLSearchParams, now: Date): ExplorerState {
  const rawRange = params.get('range');
  let range: CostRange;
  if (rawRange === 'custom') {
    const from = params.get('from');
    const to = params.get('to');
    range = from && to ? { preset: 'custom', from, to } : resolvePreset(DEFAULT_RANGE_PRESET, now);
  } else if (rawRange && isResolvablePreset(rawRange)) {
    range = resolvePreset(rawRange, now);
  } else {
    range = resolvePreset(DEFAULT_RANGE_PRESET, now);
  }

  const projectId = params.get('project');
  const rawSessionId = params.get('session');
  const sessionId = projectId && rawSessionId ? rawSessionId : null;

  return { range, projectId, sessionId };
}

/** A clock reading held still, and the key it was taken for. */
export interface ClockAnchor {
  key: string;
  now: Date;
}

/**
 * Which parts of the URL are allowed to move the resolved window: the range
 * controls, and nothing else.
 *
 * Deliberately NOT the whole search string. `project` and `session` change on
 * every drill-down, and a drill-down is not a request for a fresher window —
 * it is a request for a narrower scope of the *same* window. Keying on the
 * whole URL would re-read the clock there, with two costs:
 *
 *  - **The levels would disagree.** The projects table computes Alpha over the
 *    window that was current when it loaded; the sessions level underneath it
 *    would compute Alpha over that window plus however long the user spent
 *    reading. Both are labelled "Last 30 days", and while a session is actively
 *    spending they need not add up. Two screens disagreeing under one label is
 *    the exact defect this explorer exists to remove.
 *  - **Back would never hit cache.** Returning to the projects level would mint
 *    keys nobody has fetched, so Back means skeletons rather than the instant
 *    restore it implies. `staleTime` cannot help — a new key is a new `Query`
 *    with no data in it.
 *
 * An explicit range change still advances the window, because that is exactly
 * what the user asked for. Reading only these three keys also means any param
 * this page grows later cannot disturb the window by accident.
 */
export function explorerClockKey(params: URLSearchParams): string {
  return [params.get('range'), params.get('from'), params.get('to')].join('|');
}

/**
 * The pure half of `useExplorerClockAnchor`: keep `current` when it was taken
 * for the same `key`, otherwise take a fresh reading. Returning the *same
 * object* on a match is the whole point — that identity is what makes the
 * resolved window, and therefore every query key derived from it, stable
 * across renders.
 *
 * Split out of the hook so the retention rule is asserted directly, with an
 * injected `readClock`, rather than inferred from a rendered component.
 */
export function nextClockAnchor(
  current: ClockAnchor | null,
  key: string,
  readClock: () => Date,
): ClockAnchor {
  if (current && current.key === key) return current;
  return { key, now: readClock() };
}

/**
 * The instant this explorer's presets resolve against: read once per range
 * selection, then held.
 *
 * Why held at all: a preset is a window relative to now, so "now" has to be
 * re-read *sometime* or a long-lived tab keeps reporting a stale window. Every
 * render is far too often — that is the defect this replaces, a request loop
 * rather than a slow drift. `explorerClockKey` above decides the "sometime":
 * an explicit range change, or a reload. Not a drill-down, and not Back.
 *
 * Why not quantize instead: flooring `to` to the minute or hour lowers the rate
 * the key changes at, it does not stop the key changing. Every boundary
 * crossing still re-keys and refetches every mounted query, so a dashboard
 * someone is reading blanks into skeletons on a timer — and the grain is the
 * only thing holding it back, since flooring to a grain near the render cadence
 * restores the loop in full (320 requests per 150 ms at a 1 ms grain, against
 * 324 unfloored). A failure that appears at unpredictable moments is worse than
 * a constant one, because only the constant one shows up in a local run.
 * Holding the reading removes the moving input rather than sampling it slower.
 *
 * Why derived state rather than `useMemo` or a ref. All three work; the
 * argument is about what each one costs, and it is narrower than it looks:
 *
 *  - `useMemo` would very probably be fine. React documents its cache as a hint
 *    it may discard, but it has never actually done so outside a hidden
 *    `<Activity>` tree, and StrictMode's second pass reuses it. A discard here
 *    would also NOT restore the loop: it costs one extra clock read and one
 *    refetch, the same price already accepted for a concurrent render below.
 *    Looping would need a discard on *every* render. So "the memo might be
 *    dropped" is a real but small cost, not the catastrophe it first looks.
 *  - A ref would work too, but writing `ref.current` during render is against
 *    React's documented rules. It goes unflagged here only because this repo
 *    pins `eslint-plugin-react-hooks@5.2.0` with `exhaustive-deps` as its one
 *    enabled rule and React Compiler is off — `react-hooks/refs` in v6 would
 *    flag it, and the compiler bails out of any component that does it. Buying
 *    a guarantee with a compiler bailout is a bad trade.
 *  - `useState` gives the retention guarantee outright (state is never
 *    discarded) with no rule to bend, and adjusting it during render is a
 *    documented React pattern for exactly this — a value that has to reset when
 *    an input changes. So: no memo semantics to rely on, no compiler bailout.
 *
 * State starts as `null` rather than a lazily-initialized reading so that
 * `nextClockAnchor` is the file's ONE clock read — every path, mount included,
 * goes through the same gate, and "this file reads the clock exactly once" is
 * a thing a test can assert outright.
 *
 * It takes the raw `URLSearchParams` and calls `explorerClockKey` itself rather
 * than accepting a prepared key. A key parameter is a seam a caller can widen
 * — `useExplorerClockAnchor(explorerClockKey(p) + p.get('project'))` type-checks
 * and silently restores the per-drill-down re-read this exists to prevent.
 * Owning the derivation makes that unrepresentable instead of merely tested.
 *
 * `nextClockAnchor` returns the held object unless the key changed, so
 * `setHeld` is reached on mount and on a real range change, and nowhere else.
 * React then re-renders this component immediately, before its children; that
 * second pass sees the matching key and stops. Both passes return the same,
 * correct anchor, so no child ever renders against a stale window.
 *
 * This cannot spin: the key comes from the URL, and nothing a query returns can
 * change the URL. A key that cannot move on its own is what bounds this
 * structurally rather than by convention.
 *
 * Exported for its own tests. `renderToStaticMarkup` runs React's real
 * render-phase update loop, so the holding, the two-pass settle and the single
 * child render are all assertable directly — see `cost-explorer.test.tsx`.
 */
export function useExplorerClockAnchor(params: URLSearchParams): Date {
  const [held, setHeld] = useState<ClockAnchor | null>(null);
  const anchor = nextClockAnchor(held, explorerClockKey(params), () => new Date());
  if (anchor !== held) setHeld(anchor);
  return anchor.now;
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
 * shareable. The one thing the URL cannot hold is the instant a *preset*
 * resolves against, so that comes from `useExplorerClockAnchor` — one clock
 * reading per range selection, held across renders and across drill-downs,
 * because both bounds it produces sit inside the query keys of every level
 * below. All three levels therefore report the same window, and Back up the
 * hierarchy restores from cache instead of refetching.
 *
 * Every push clears this component's own keys first (`EXPLORER_PARAM_KEYS`)
 * and re-applies `serializeExplorerState`'s output on top of the *current*
 * search string, so an unrelated param already on the URL (this page's own
 * `?tab=transactions`) survives untouched.
 */
export function CostExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = useExplorerClockAnchor(searchParams);
  const state = parseExplorerState(searchParams, now);

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
