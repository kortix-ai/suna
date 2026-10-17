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

/** One histogram bar: a time slice of the loaded runs (the Models logs pattern). */
export interface RunBucket {
  /** Start of the slice, epoch ms. */
  start: number;
  /** End of the slice, epoch ms. The last slice includes its end. */
  end: number;
  total: number;
  /** Runs that read Failed or Rejected. */
  failed: number;
  medianMs: number | null;
  /** Summed `cost_usd`. */
  cost: number;
}

type BucketRun = Pick<
  ProjectTriggerRun,
  'started_at' | 'status' | 'run_status' | 'duration_ms' | 'cost_usd'
>;

/**
 * The loaded runs split into `count` equal time slices by `started_at`, from
 * the oldest loaded run to the newest: `bucketLogStats` in `gateway-logs.tsx`,
 * over runs. It describes the window on screen, not all history.
 */
export function bucketRuns(runs: readonly BucketRun[], count: number): RunBucket[] {
  const at = (r: BucketRun) => Date.parse(r.started_at);
  const timed = runs.filter((r) => Number.isFinite(at(r)));
  if (timed.length === 0 || count < 1) return [];
  const times = timed.map(at);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const size = Math.max(1, max - min) / count;
  const groups: BucketRun[][] = Array.from({ length: count }, () => []);
  for (const run of timed)
    groups[Math.min(count - 1, Math.floor((at(run) - min) / size))]!.push(run);
  return groups.map((group, i) => ({
    start: min + i * size,
    end: i === count - 1 ? max : min + (i + 1) * size,
    total: group.length,
    failed: group.filter((r) => {
      const state = runState(r);
      return state === 'failed' || state === 'rejected';
    }).length,
    medianMs: medianDuration(group),
    cost: group.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
  }));
}

/** The median `duration_ms` of the runs that have one, or null. */
export function medianDuration(
  runs: readonly Pick<ProjectTriggerRun, 'duration_ms'>[],
): number | null {
  const values = runs
    .map((r) => r.duration_ms)
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/** True when the run started inside the window (both ends inclusive). */
export function inRunRange(
  run: Pick<ProjectTriggerRun, 'started_at'>,
  range: { start: number; end: number } | null,
): boolean {
  if (!range) return true;
  const t = Date.parse(run.started_at);
  return t >= range.start && t <= range.end;
}

/** The source a trigger's own runs come from; a row names any other one (manual, replay, reminder). */
export function isDefaultSource(
  triggerType: 'cron' | 'webhook' | 'event' | 'monitor',
  source: ProjectTriggerRun['source'],
): boolean {
  return source === triggerType;
}
