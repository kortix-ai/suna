/**
 * The durable job queue's loop (shared/job-queue.ts): every replica claims and
 * runs due jobs; SKIP LOCKED spreads the work. A full batch means more work is
 * likely waiting, so the next tick runs at once; else after IDLE_MS.
 */
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import { runJobBatch } from '../shared/job-queue';

const IDLE_MS = 2_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

async function tick(): Promise<void> {
  let delay = IDLE_MS;
  try {
    if ((await runWorkerTick('job-queue', () => runJobBatch())) > 0) delay = 0;
  } catch (error) {
    logger.error('[job-queue] tick failed', { error: String(error) });
  }
  if (!stopped) timer = setTimeout(tick, delay);
}

export function startJobWorker(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(tick, IDLE_MS);
}

export function stopJobWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
