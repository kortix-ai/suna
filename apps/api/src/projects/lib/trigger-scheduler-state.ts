import { config } from '../../config';
import { isPlainObject } from '../../shared/json';

export type TriggerSchedulerTimer = ReturnType<typeof setInterval>;

export const globalForProjectTriggers = globalThis as typeof globalThis & {
  __kortixProjectTriggerSchedulerTimer?: TriggerSchedulerTimer | null;
};

// In-memory heartbeat for the trigger scheduler, surfaced at /health so an
// operator can tell at a glance whether the leader's sweep is alive and what
// the last pass did. Lives on the leader pod; resets on restart. This is the
// answer to "how would anyone know the scheduler stopped firing?".
export interface TriggerSchedulerHealth {
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  lastSweepDurationMs: number | null;
  lastResult: {
    projects: number;
    projectFailures: number;
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  } | null;
  lastError: string | null;
  catalogPendingProjects: number | null;
  lastCatalogSweepCompletedAt: string | null;
  lastCatalogSweepResult: {
    scanned: number;
    synced: number;
    errors: number;
  } | null;
  lastCatalogSweepError: string | null;
  catalogCursor: string | null;
  discoveryCursor: string | null;
  catalogCycleCompletedAt: string | null;
  discoveryCycleCompletedAt: string | null;
  lastClaimLagMs: number | null;
  maxObservedClaimLagMs: number | null;
  lastExecutionDrainStartedAt: string | null;
  lastExecutionDrainCompletedAt: string | null;
  lastExecutionResult: {
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  } | null;
  lastExecutionError: string | null;
}
export const schedulerHealth: TriggerSchedulerHealth = {
  lastSweepStartedAt: null,
  lastSweepCompletedAt: null,
  lastSweepDurationMs: null,
  lastResult: null,
  lastError: null,
  catalogPendingProjects: null,
  lastCatalogSweepCompletedAt: null,
  lastCatalogSweepResult: null,
  lastCatalogSweepError: null,
  catalogCursor: null,
  discoveryCursor: null,
  catalogCycleCompletedAt: null,
  discoveryCycleCompletedAt: null,
  lastClaimLagMs: null,
  maxObservedClaimLagMs: null,
  lastExecutionDrainStartedAt: null,
  lastExecutionDrainCompletedAt: null,
  lastExecutionResult: null,
  lastExecutionError: null,
};
export function getTriggerSchedulerHealth(): TriggerSchedulerHealth {
  return schedulerHealth;
}

export function initialCatalogBackfillIncomplete(
  health: Pick<
    TriggerSchedulerHealth,
    'catalogCycleCompletedAt' | 'discoveryCycleCompletedAt' | 'catalogPendingProjects'
  >,
): boolean {
  return (
    health.catalogCycleCompletedAt === null ||
    health.discoveryCycleCompletedAt === null ||
    (health.catalogPendingProjects ?? 1) > 0
  );
}

// ─── Reliability: timeouts + stall detection ─────────────────────────────────
// The 2026-06-21 fleet-wide cron outage: one trigger fire (continueSession
// resuming a dead sandbox) hung forever inside a SEQUENTIAL sweep that awaited
// it with no timeout, so the in-flight guard never cleared and EVERY cron
// stopped firing for ~18h with no error. These bounds make a hung/slow fire
// survivable: one trigger can fail, the rest of the fleet still fires, and the
// scheduler can never wedge — no matter what.

/** Hard cap on a single trigger fire (createSession/continueSession). */
export function triggerFireTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_FIRE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45_000;
}

/** Number of project manifests the connector reconciler processes in parallel. */
export function connectorProjectConcurrency(): number {
  const raw = Number(process.env.KORTIX_CONNECTOR_PROJECT_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

/** Maximum wall time for one connector reconciliation. */
export function connectorProjectTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_CONNECTOR_PROJECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

/** Rotating raw-git discovery batch size. */
export function manifestDiscoveryBatchSize(): number {
  const raw = Number(process.env.KORTIX_MANIFEST_DISCOVERY_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

/** Known manifest projects reconciled per connector sweep. */
export function manifestCatalogBatchSize(): number {
  const raw = Number(process.env.KORTIX_MANIFEST_CATALOG_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/**
 * Resolve `p`, or reject once `ms` elapses. The underlying work is NOT
 * cancellable (JS has no promise cancellation), but rejecting lets the caller
 * move on / clear its guard instead of blocking forever on a hung await.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map all items through a bounded worker pool.
 *
 * The output order matches the input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  configuredConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, Math.floor(configuredConcurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

/**
 * Pure stall check: is the leader's scheduler failing to make progress? Surfaced
 * at /health and used by the in-loop watchdog so a frozen scheduler is loud, not
 * silent. NOT stale when: not leader, the scheduler hasn't ticked yet (grace
 * right after promotion), a sweep completed recently, OR a sweep is in-flight and
 * still within the stale window. Stale only when the latest sweep has been
 * IN-FLIGHT longer than `staleMs`, or the last COMPLETED sweep is older than
 * `staleMs` (the interval died). The in-flight case is why we key off the start
 * time, not a `lastDone=0` sentinel — otherwise a fresh leader's very first
 * (legitimately long) sweep would read as stale the instant it began.
 */
export function isSweepStale(opts: {
  isLeader: boolean;
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  nowMs: number;
  staleMs: number;
}): boolean {
  if (!opts.isLeader) return false;
  if (!opts.lastSweepStartedAt) return false;
  const startedMs = Date.parse(opts.lastSweepStartedAt);
  const completedMs = opts.lastSweepCompletedAt ? Date.parse(opts.lastSweepCompletedAt) : 0;
  // The latest sweep already completed → healthy unless the NEXT one is overdue.
  if (completedMs >= startedMs) return opts.nowMs - completedMs > opts.staleMs;
  // A sweep is in-flight (started, not yet completed) → stale only if it has been
  // running longer than the stale window.
  return opts.nowMs - startedMs > opts.staleMs;
}

function schedulerStaleMs(): number {
  return Math.max(5 * triggerSchedulerIntervalMs(), 5 * 60_000);
}

/** Is the leader's trigger sweep stalled right now? (Wraps the pure check.) */
export function schedulerSweepIsStale(isLeaderNow: boolean, nowMs: number = Date.now()): boolean {
  return isSweepStale({
    isLeader: isLeaderNow,
    lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
    lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
    nowMs,
    staleMs: schedulerStaleMs(),
  });
}

// Connector reconcile sweep — runs on a slower cadence than the trigger sweep.

export function connectorSweepIntervalMs() {
  const raw = Number(process.env.KORTIX_CONNECTOR_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

export function triggerSchedulerIntervalMs() {
  const raw = Number((config as any).KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000;
}

export function triggerScheduleClaimLimit(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_SCHEDULE_CLAIM_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 250;
}

export function triggerExecutionConcurrency(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_EXECUTION_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

/**
 * Server-side, per-project trigger kill-switch (`projects.metadata.triggers_paused`).
 * When paused, the platform does NOT auto-run any of the project's triggers —
 * the cron sweep skips it and inbound webhooks are ignored — even though each
 * trigger is still `enabled` in the repo. This is how you stop ONE repo
 * deployed to TWO independent control planes (e.g. dev.kortix.com + kortix.com,
 * separate DBs/schedulers with no cross-platform dedup) from double-firing every
 * cron: pause it on the deployment you don't want firing. A manual
 * `…/triggers/:slug/fire` is an explicit action and still runs. Toggle via
 * `PATCH /:projectId/triggers/activation`.
 */
export function triggersPausedForProject(metadata: unknown): boolean {
  return isPlainObject(metadata) && (metadata as Record<string, unknown>).triggers_paused === true;
}

export function withTriggersPaused(metadata: unknown, paused: boolean): Record<string, unknown> {
  const base = isPlainObject(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  if (paused) base.triggers_paused = true;
  else delete base.triggers_paused;
  return base;
}
