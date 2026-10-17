import type { ProjectTriggerRun } from '@kortix/sdk';

/** The one label a run shows: the fire outcome, refined by the agent turn's outcome once it fired. */
export type RunState =
  'queued' | 'running' | 'started' | 'succeeded' | 'failed' | 'rejected' | 'skipped';

export function runState(run: Pick<ProjectTriggerRun, 'status' | 'run_status'>): RunState {
  if (run.status !== 'fired') return run.status;
  if (run.run_status === 'running') return 'running';
  if (run.run_status === 'succeeded') return 'succeeded';
  if (run.run_status === 'failed') return 'failed';
  return 'started';
}

/** Poll the run list every 5 s while any shown run is still in flight; otherwise not at all. */
export const RUNS_POLL_MS = 5000;

export function runsInFlight(
  runs: readonly Pick<ProjectTriggerRun, 'status' | 'run_status'>[],
): boolean {
  return runs.some(
    (r) => r.status === 'queued' || r.status === 'running' || r.run_status === 'running',
  );
}

/** Replay is offered on a failed or rejected fire whose payload was stored whole. */
export function canReplay(
  run: Pick<ProjectTriggerRun, 'status' | 'run_status' | 'payload'>,
): boolean {
  const state = runState(run);
  return (state === 'failed' || state === 'rejected') && run.payload?.truncated !== true;
}

/**
 * The Failed runs badge: failures of a trigger on this page since its last
 * successful fire. A failure followed by a good run no longer needs attention.
 * The list itself still shows every failed run.
 */
export function unseenFailures(
  runs: readonly Pick<ProjectTriggerRun, 'slug' | 'started_at'>[],
  triggers: readonly { slug: string; last_fired_at?: string | null }[],
): number {
  const lastFired = new Map(triggers.map((t) => [t.slug, t.last_fired_at ?? null] as const));
  return runs.filter((run) => {
    if (!lastFired.has(run.slug)) return false;
    const last = lastFired.get(run.slug);
    return !last || Date.parse(run.started_at) > Date.parse(last);
  }).length;
}

/** "5 minutes ago", "yesterday", in the viewer's locale; a date after 30 days. */
export function relativeRunTime(iso: string, locale: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const elapsed = Math.max(0, now - at);
  const min = Math.floor(elapsed / 60_000);
  if (min < 1) return rtf.format(0, 'second');
  if (min < 60) return rtf.format(-min, 'minute');
  if (min < 24 * 60) return rtf.format(-Math.floor(min / 60), 'hour');
  if (min < 30 * 24 * 60) return rtf.format(-Math.floor(min / (24 * 60)), 'day');
  return new Date(at).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The payload editor's text, as the object `fire` takes. */
export function parsePayload(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: 'json' | 'object' } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
