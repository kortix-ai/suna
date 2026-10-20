// Serial one-minute sweep that moves idle sessions off a fallback model once
// their own model serves again, one chain per leadership term (shared/leader-timer.ts).

import { revertIdleSessionFallbacks } from '../projects/surface';
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const TICK_MS = 60_000;

const sweeper = leaderTimer(async () => {
  try {
    await runWorkerTick('session-model-fallback', () => revertIdleSessionFallbacks());
  } catch (err) {
    logger.warn('[session model fallback] tick failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return TICK_MS;
});

export const startSessionModelFallbackWorker = sweeper.start;
export const stopSessionModelFallbackWorker = sweeper.stop;
