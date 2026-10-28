/**
 * The durable job queue's loop (shared/job-queue.ts): every replica claims due
 * jobs into its free slots; SKIP LOCKED spreads the work. A job that settles
 * frees its slot and wakes the loop, so a backlog runs back to back; with no
 * slot freed the next claim is after IDLE_MS.
 */
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import { runJobBatch } from '../shared/job-queue';

const IDLE_MS = 2_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let ticking = false;
let again = false;

async function tick(): Promise<void> {
  // One tick at a time: a job that settles during a tick asks for another one after it.
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  timer = null;
  let delay = IDLE_MS;
  try {
    await runWorkerTick('job-queue', () => runJobBatch(4, { wait: false, onSlotFree: wake }));
  } catch (error) {
    logger.error('[job-queue] tick failed', { error: String(error) });
  }
  ticking = false;
  if (again) {
    again = false;
    delay = 0;
  }
  if (!stopped) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }
}

/** A job settled and freed its slot: claim into it now, not after the idle wait. */
function wake(): void {
  if (stopped) return;
  if (ticking) {
    again = true;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, 0);
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
