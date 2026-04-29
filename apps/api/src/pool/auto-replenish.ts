import { replenish, cleanup } from './index';
import { logger } from '../lib/logger';

let interval: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 60_000;

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
  try {
    await cleanup();
    await replenish();
  } catch (err) {
    logger.error('[POOL] Auto-replenish tick failed:', { error: err instanceof Error ? err.message : String(err) });
  }
}
