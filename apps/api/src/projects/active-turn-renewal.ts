import { logger } from '../lib/logger';
import type { ReapResult } from './sandbox-reaper';

const DEFAULT_ACTIVE_TURN_RENEWAL_INTERVAL_MS = 20_000;
const MIN_ACTIVE_TURN_RENEWAL_INTERVAL_MS = 5_000;
const MAX_ACTIVE_TURN_RENEWAL_INTERVAL_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;
type Reap = (
  now?: Date,
  dependencyOverrides?: Record<string, never>,
  scope?: { sandboxIds?: readonly string[]; activeTurnsOnly?: boolean },
) => Promise<ReapResult>;
type Schedule = (callback: () => void, delayMs: number) => Timer;
type Cancel = (timer: Timer) => void;

export interface ActiveTurnRenewalDependencies {
  reap?: Reap;
  now?: () => Date;
  schedule?: Schedule;
  cancel?: Cancel;
  intervalMs?: () => number;
  monotonicNowMs?: () => number;
}

const state = globalThis as typeof globalThis & {
  __kortixActiveTurnRenewalTimer?: Timer | null;
  __kortixActiveTurnRenewalRunning?: boolean;
  __kortixActiveTurnRenewalGeneration?: number;
  __kortixActiveTurnRenewalCancel?: Cancel;
};

export function activeTurnRenewalIntervalMs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const parsed = Number.parseInt(env.KORTIX_ACTIVE_TURN_RENEWAL_INTERVAL_MS ?? '', 10);
  const configured = Number.isFinite(parsed) ? parsed : DEFAULT_ACTIVE_TURN_RENEWAL_INTERVAL_MS;
  return Math.min(
    MAX_ACTIVE_TURN_RENEWAL_INTERVAL_MS,
    Math.max(MIN_ACTIVE_TURN_RENEWAL_INTERVAL_MS, configured),
  );
}

async function defaultReap(
  now?: Date,
  dependencyOverrides?: Record<string, never>,
  scope?: { sandboxIds?: readonly string[]; activeTurnsOnly?: boolean },
): Promise<ReapResult> {
  const { reapAndReconcileSandboxes } = await import('./sandbox-reaper');
  return reapAndReconcileSandboxes(now, dependencyOverrides, scope);
}

/** Run one provider-neutral pass over rows that currently hold turn authority. */
export async function runActiveTurnRenewal(
  dependencies: ActiveTurnRenewalDependencies = {},
): Promise<ReapResult> {
  const reap = dependencies.reap ?? defaultReap;
  return reap((dependencies.now ?? (() => new Date()))(), {}, { activeTurnsOnly: true });
}

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
    if (result.candidates > 0 || result.errors > 0) {
      logger.info('[active-turn-renewal] pass', {
        candidates: result.candidates,
        matching: result.matching,
        deferred: result.deferred,
        lifecycleRenewed: result.lifecycleRenewed,
        reconciled: result.reconciled,
        errors: result.errors,
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
        () => void tick(generation, dependencies),
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
  void tick(generation, dependencies);
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
