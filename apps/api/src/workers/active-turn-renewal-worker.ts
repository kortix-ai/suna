import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';
import {
  type ActiveTurnRenewalDependencies,
  activeTurnRenewalIntervalMs,
  runActiveTurnRenewal,
} from '../projects/active-turn-renewal';

type Timer = ReturnType<typeof setTimeout>;
type Cancel = (timer: Timer) => void;

const state = globalThis as typeof globalThis & {
  __kortixActiveTurnRenewalTimer?: Timer | null;
  __kortixActiveTurnRenewalRunning?: boolean;
  __kortixActiveTurnRenewalGeneration?: number;
  __kortixActiveTurnRenewalCancel?: Cancel;
};

function isCurrentGeneration(generation: number): boolean {
  return (
    state.__kortixActiveTurnRenewalRunning === true &&
    state.__kortixActiveTurnRenewalGeneration === generation
  );
}

async function tick(
  generation: number,
  dependencies: ActiveTurnRenewalDependencies,
): Promise<void> {
  if (!isCurrentGeneration(generation)) return;
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const startedAtMs = monotonicNowMs();
  try {
    const result = await runActiveTurnRenewal(dependencies);
    if (result.candidates > 0 || result.errors > 0 || result.transient > 0) {
      logger.info('[active-turn-renewal] pass', {
        candidates: result.candidates,
        matching: result.matching,
        deferred: result.deferred,
        lifecycleRenewed: result.lifecycleRenewed,
        reconciled: result.reconciled,
        errors: result.errors,
        transient: result.transient,
      });
    }
  } catch (error) {
    logger.error('[active-turn-renewal] pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (isCurrentGeneration(generation)) {
      const schedule = dependencies.schedule ?? setTimeout;
      const intervalMs = (dependencies.intervalMs ?? activeTurnRenewalIntervalMs)();
      const delayMs = Math.max(0, intervalMs - (monotonicNowMs() - startedAtMs));
      state.__kortixActiveTurnRenewalCancel = dependencies.cancel ?? clearTimeout;
      state.__kortixActiveTurnRenewalTimer = schedule(
        () => void runWorkerTick('active-turn-renewal', () => tick(generation, dependencies)),
        delayMs,
      );
    }
  }
}

export function startActiveTurnRenewal(
  dependencies: ActiveTurnRenewalDependencies = {},
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  if (env.KORTIX_ACTIVE_TURN_RENEWAL_ENABLED === 'false') return;
  if (state.__kortixActiveTurnRenewalRunning) return;
  state.__kortixActiveTurnRenewalRunning = true;
  const generation = (state.__kortixActiveTurnRenewalGeneration ?? 0) + 1;
  state.__kortixActiveTurnRenewalGeneration = generation;
  void runWorkerTick('active-turn-renewal', () => tick(generation, dependencies));
}

export function stopActiveTurnRenewal(): void {
  state.__kortixActiveTurnRenewalRunning = false;
  state.__kortixActiveTurnRenewalGeneration = (state.__kortixActiveTurnRenewalGeneration ?? 0) + 1;
  if (state.__kortixActiveTurnRenewalTimer) {
    (state.__kortixActiveTurnRenewalCancel ?? clearTimeout)(state.__kortixActiveTurnRenewalTimer);
    state.__kortixActiveTurnRenewalTimer = null;
  }
  state.__kortixActiveTurnRenewalCancel = undefined;
}
