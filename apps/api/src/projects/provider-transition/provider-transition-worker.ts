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

type Timer = ReturnType<typeof setInterval>;
const g = globalThis as unknown as { __kortixProviderTransitionTimer?: Timer | null };
let timer: Timer | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_PROVIDER_TRANSITION_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}
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

export function startProviderTransitionWorker(): void {
  if (process.env.KORTIX_PROVIDER_TRANSITION_WORKER_ENABLED === 'false') return;
  if (g.__kortixProviderTransitionTimer) clearInterval(g.__kortixProviderTransitionTimer);
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runProviderTransitionTick()
      .catch((err) =>
        logger.error('[provider-transition-worker] tick failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs());
  g.__kortixProviderTransitionTimer = timer;
}

export function stopProviderTransitionWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (g.__kortixProviderTransitionTimer) {
    clearInterval(g.__kortixProviderTransitionTimer);
    g.__kortixProviderTransitionTimer = null;
  }
}
