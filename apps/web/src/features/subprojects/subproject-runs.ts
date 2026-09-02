import type { SubprojectRun, SubprojectRunStats, SubprojectRunStatus } from '@kortix/sdk';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * Subproject-run presentation helpers.
 *
 * This module used to hold a hardcoded seven-report mock. It now holds no data:
 * the pages read `useProjectSubprojectRuns()` / `useSubprojectRuns()`. What is left is
 * formatting and ordering the API does not do.
 *
 * SERVER-SAFE and React-free on purpose, same as before — no icon values, no
 * hooks — so a server component may import it.
 *
 * Two shape changes from the mock, both forced by real data:
 *
 *  1. `minutesAgo: number` became `started_at: string`. The mock used fixed
 *     offsets to dodge an SSR/client hydration mismatch; a real run has a real
 *     instant, so the formatting happens client-side and the timestamp travels
 *     untouched.
 *  2. Five statuses became SEVEN. `project_trigger_executions` has no `failed`
 *     state — a failed attempt returns to `queued` with an error and only
 *     becomes `dead_lettered` after five tries — so `retrying` is a state the
 *     report must show, and `skipped` is not a failure. See
 *     `apps/api/src/projects/subproject-run-status.ts`.
 */

export type { SubprojectRun, SubprojectRunStats, SubprojectRunStatus };

/**
 * What each run status is CALLED. Its own map rather than the session one:
 * `retrying` and `skipped` have no session equivalent, and `legacy` /
 * `needs-you` can never describe a run.
 */
const STATUS_LABELS: Record<SubprojectRunStatus, string> = {
  starting: 'Starting',
  retrying: 'Retrying',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  skipped: 'Skipped',
};

export const subprojectRunStatusLabel = (status: SubprojectRunStatus): string =>
  STATUS_LABELS[status];

/** The run a strip or a row is anchored on. Newest first, as the API returns. */
export const latestRun = (runs: readonly SubprojectRun[]): SubprojectRun | null => runs[0] ?? null;

/**
 * The newest `limit` runs, rendered OLDEST-FIRST.
 *
 * The API returns newest-first; a strip reads left-to-right as a timeline, so
 * the newest circle sits next to the row's relative-time column. Every
 * status-history strip in the tools our users already live in — Grafana,
 * Datadog, CI checks — runs that direction.
 */
export function subprojectRunStrip(runs: readonly SubprojectRun[], limit: number): SubprojectRun[] {
  return runs.slice(0, limit).reverse();
}

/** Group a flat run list by subproject, preserving the API's newest-first order. */
export function groupRunsBySubproject(
  runs: readonly SubprojectRun[],
): Map<string, SubprojectRun[]> {
  const bySubproject = new Map<string, SubprojectRun[]>();
  for (const run of runs) {
    const existing = bySubproject.get(run.subproject_slug);
    if (existing) existing.push(run);
    else bySubproject.set(run.subproject_slug, [run]);
  }
  return bySubproject;
}

/**
 * Relative time, formatted client-side from a real instant.
 *
 * `now` is injectable so a test is not at the mercy of the clock, and so a
 * render can pass one value to every row rather than drifting between them.
 */
export function agoLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return weeks < 5 ? `${weeks}w ago` : `${Math.round(days / 30)}mo ago`;
}

/** Wall-clock length, or an em dash while the run is still open. */
export function durationLabel(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) return '—';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Success rate as a label. `null` means no settled verdict yet, not 0%. */
export function successRateLabel(rate: number | null): string {
  return rate === null ? '—' : `${rate}%`;
}

/** Average duration as a label, from whole seconds. */
export function avgDurationLabel(seconds: number | null): string {
  return seconds === null ? '—' : durationLabel(seconds * 1000);
}

/**
 * One line explaining a run, for the dot tooltip and the detail list.
 *
 * Prefers the session's generated title — real data, produced by the titling
 * hook. A run that produced no session has no title, so the status speaks for
 * it; and a failed dispatch carries its error, which is the most useful thing
 * the row can say.
 */
export function runSummary(run: SubprojectRun): string {
  if (run.summary) return run.summary;
  if (run.status === 'failed' && run.last_error) return run.last_error;
  if (run.status === 'skipped') return 'Skipped — a filter or the pause switch declined this fire';
  if (run.status === 'retrying') return `Attempt ${run.attempts} failed; retrying`;
  return 'No session was created for this fire';
}

/** `/projects/:id/sessions/:sid` — where a run circle goes. Null when it never made one. */
export function subprojectRunHref(projectId: string, run: SubprojectRun): string | null {
  return run.session_id ? `/projects/${projectId}/sessions/${run.session_id}` : null;
}

/** One subproject's run report. */
export const subprojectReportHref = (projectId: string, slug: string): string =>
  `/projects/${projectId}/subprojects/runs/${slug}`;

/** Every subproject's runs. */
export const subprojectReportsHref = (projectId: string): string =>
  `/projects/${projectId}/subprojects/runs`;

/**
 * The store — the **Marketplace** capability tab, not `/subprojects`.
 *
 * The store moved under Customize (`CAPABILITY_TABS`, key `marketplace`) so it
 * sits beside Models / Connectors / Agents / Skills / Triggers instead of
 * carrying its own sidebar row. `/projects/<id>/subprojects` still resolves —
 * it is a server redirect to this href — but nothing in the app should link at
 * it, or a click costs a redirect hop it does not need.
 *
 * Every link to the store goes through this function. Two call sites hand-built
 * the URL before the move (`subprojects-home-preview.tsx`,
 * `subproject-reports-view.tsx`) and both silently kept pointing at the old
 * segment; they call this now. Keep it that way — the next move is then one
 * line, not a grep.
 *
 * Built by `capabilityTabHref`, not by interpolation, for the same reason
 * `channelsHref` is: the key is typed as `CapabilityTab['key']`, so renaming or
 * dropping the tab fails THIS line at compile time instead of leaving a link to
 * a 404. That import is type-safe for a server component — `capability-tab-routes`
 * is pure data with no icon import, which is why it may be imported here at all.
 */
export const subprojectsHref = (projectId: string): string =>
  capabilityTabHref(projectId, 'marketplace');
