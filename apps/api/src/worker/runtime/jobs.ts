/**
 * Starts and stops every scheduled job (`worker/jobs/index.ts`) for one
 * leadership term. Leader election calls `startJobs` on acquire and
 * `stopJobs` on release (`bootstrap.ts`); both are idempotent across lease
 * flaps.
 */
import { config } from '../../config';
import { JOBS } from '../jobs';
import { startJobHeartbeat } from './heartbeat';
import type { Job } from './job';

let started: readonly Job[] | null = null;
let heartbeat: { stop(): void } | null = null;

export async function startJobs(jobs: readonly Job[] = JOBS): Promise<void> {
  if (!config.KORTIX_WORKERS_ENABLED || started) return;
  started = jobs;
  heartbeat = startJobHeartbeat(jobs);
  for (const job of jobs) await job.start();
}

// Every stop runs before the first await, then the in-flight ticks drain together. A stop after an
// await left its job "started" across that await; a re-acquire then started nothing, and the stop
// ran after it (2026-10-16 prod: 18 job loops stayed off after a lease flap).
export async function stopJobs(): Promise<void> {
  const jobs = started;
  if (!jobs) return;
  started = null;
  heartbeat?.stop();
  heartbeat = null;
  const drains = jobs.map((job) => job.stop());
  await Promise.all(drains);
}
