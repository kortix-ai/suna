/**
 * Resume loop for durable provider-migration transitions — the durability
 * guarantee (red-team #4). Each tick finds live rows whose lease went stale
 * (crashed/restarted worker) or whose backoff gate has passed, and re-drives
 * them. driveProviderTransition re-acquires the lease, so concurrent ticks and
 * multiple API instances are safe. Resumes EVERY non-terminal status (pending,
 * building, ready, activating) — a crash at ready or mid-activating converges.
 */
import { db as appDb } from '../../shared/db';
import { logger } from '../../lib/logger';
import { driveProviderTransition } from './provider-transition-runner';
import { defaultTransitionDeps } from './provider-transition-service';
import {
  countLiveTransitions,
  findResumableTransitions,
} from './provider-transition-store';
import { LEASE_TTL_MS } from './provider-transition-runner';
import { setProviderTransitionsInFlight } from './provider-transition-metrics';

function batchSize(): number {
  const raw = Number(process.env.KORTIX_PROVIDER_TRANSITION_WORKER_BATCH);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

export async function runProviderTransitionTick(): Promise<{ resumed: number }> {
  const deps = defaultTransitionDeps(appDb);
  const candidates = await findResumableTransitions(appDb, LEASE_TTL_MS, batchSize());
  let resumed = 0;
  for (const { transitionId } of candidates) {
    try {
      const outcome = await driveProviderTransition(deps, transitionId);
      if (outcome !== 'not_leased') resumed += 1;
    } catch (err) {
      logger.error('[provider-transition-worker] drive failed', {
        transitionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    setProviderTransitionsInFlight(await countLiveTransitions(appDb));
  } catch {
    /* best-effort gauge */
  }
  if (resumed > 0) logger.info('[provider-transition-worker] resumed transitions', { count: resumed });
  return { resumed };
}

export {
  startProviderTransitionWorker,
  stopProviderTransitionWorker,
} from '../../workers/provider-transition-worker';
