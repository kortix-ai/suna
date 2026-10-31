/**
 * Job heartbeat: is every scheduled job still ticking?
 *
 * 2026-10-16, prod: a leader flap left 18 job loops stopped for 12.5 h and no
 * alert fired. The runtime now watches every tick of the registered jobs
 * (`observeWorkerTicks`). A job is stale when its last successful tick is
 * older than max(10 min, 3 × the longest gap between two of its tick starts).
 * A job is judged only after it started two ticks in this leader term: a job
 * that config switches off never ticks and never reports stale.
 *
 * Once a minute the lease holder writes one JSON line to stdout. A CloudWatch
 * log metric filter (`infra/terraform/modules/ecs-api`) turns it into the
 * `Kortix/Worker` `StaleJobs` metric, and an alarm pages when it stays at 1
 * or more for 5 minutes.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { observeWorkerTicks } from '../../shared/audit-scope';
import type { Job } from './job';

export const STALE_FLOOR_MS = 10 * 60_000;
export const STALE_GAP_FACTOR = 3;
const REPORT_INTERVAL_MS = 60_000;

export interface TickTimes {
  starts: number;
  firstStartAt: number;
  lastStartAt: number;
  /** The longest gap between two consecutive tick starts. */
  maxGapMs: number;
  /** When a tick last finished without throwing. */
  lastOkAt: number | null;
}

/** Record a tick start in `times` (mutates and returns it). */
export function recordTickStart(times: TickTimes | undefined, now: number): TickTimes {
  if (!times) return { starts: 1, firstStartAt: now, lastStartAt: now, maxGapMs: 0, lastOkAt: null };
  times.maxGapMs = Math.max(times.maxGapMs, now - times.lastStartAt);
  times.lastStartAt = now;
  times.starts += 1;
  return times;
}

/** The tick names whose last successful tick is overdue. */
export function staleTicks(ticks: ReadonlyMap<string, TickTimes>, now: number): string[] {
  const stale: string[] = [];
  for (const [name, times] of ticks) {
    if (times.starts < 2) continue;
    const limit = Math.max(STALE_FLOOR_MS, STALE_GAP_FACTOR * times.maxGapMs);
    if (now - (times.lastOkAt ?? times.firstStartAt) > limit) stale.push(name);
  }
  return stale.sort();
}

/** Watch the ticks of `jobs` and report once a minute. Returns the stop. */
export function startJobHeartbeat(
  jobs: readonly Job[],
  options: { now?: () => number; write?: (line: string) => void; intervalMs?: number } = {},
): { stop(): void; report(): string[] } {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const names = new Set(jobs.flatMap((job) => job.ticks));
  const ticks = new Map<string, TickTimes>();

  observeWorkerTicks((name) => {
    if (!names.has(name)) return undefined;
    const before = ticks.get(name);
    ticks.set(name, recordTickStart(before, now()));
    if (!before) logger.info('[worker] job ticking', { job: name });
    return (error) => {
      if (error !== undefined) return;
      const times = ticks.get(name);
      if (times) times.lastOkAt = now();
    };
  });

  const report = (): string[] => {
    const stale = staleTicks(ticks, now());
    for (const job of jobs) {
      if (job.stalled?.()) stale.push(...job.ticks.filter((name) => !stale.includes(name)));
    }
    write(
      JSON.stringify({
        kortix_metric: 'worker_jobs',
        environment: config.INTERNAL_KORTIX_ENV,
        stale_jobs: stale.length,
        jobs_seen: ticks.size,
        stale,
      }),
    );
    if (stale.length > 0) logger.warn('[worker] scheduled jobs are stale', { stale });
    return stale;
  };

  const timer = setInterval(report, options.intervalMs ?? REPORT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      observeWorkerTicks(null);
    },
    report,
  };
}
