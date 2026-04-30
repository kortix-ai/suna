import { replenish, cleanup } from './index';
import { logger } from '../lib/logger';

let interval: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 60_000;

// Guard: prevents a slow tick from overlapping with the next one.
// Without this, a large deficit (e.g. desiredCount=10, current=0) that takes
// 50-100s to provision would trigger a second tick at 60s, see the same in-flight
// deficit, and provision a second batch → provision storm.
let ticking = false;

export function start(): void {
  if (interval) return;

  logger.info(`[POOL] Auto-replenish started (every ${INTERVAL_MS / 1000}s)`);

  tick();
  interval = setInterval(tick, INTERVAL_MS);
}

export function stop(): void {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
  logger.info('[POOL] Auto-replenish stopped');
}

export function isRunning(): boolean {
  return interval !== null;
}

async function tick(): Promise<void> {
  if (ticking) {
    logger.warn('[POOL] Previous tick still running — skipping this interval');
    return;
  }
  ticking = true;
  try {
    await cleanup();
    await replenish();
  } catch (err) {
    logger.error('[POOL] Auto-replenish tick failed:', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    ticking = false;
  }
}
