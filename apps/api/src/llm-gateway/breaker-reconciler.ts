import { gatewayBreakerState, gatewayRequestLogs } from '@kortix/db';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';

// ─── Fleet-wide breaker reconciler (leader-run) ─────────────────────────────
//
// Aggregates recent UPSTREAM-DOWN failures (gateway_request_logs) per provider
// into the shared gateway_breaker_state table so a tripped provider opens across
// the whole fleet (every replica reads the snapshot via breaker-store.ts), not
// just on the replica that locally saw the burst.
//
// Leader-gated (started in index.ts startSingletonWorkers), so exactly one writer.
// Recovery is self-healing: when failures age out of the window (probes succeed,
// or traffic stops), the provider drops below threshold and is closed again.
//
// Known limitation: a request that FAILS OVER to a healthy fallback is logged
// ok=true, so a primary that always-fails-over-successfully won't fleet-open here
// (the local breaker on the replica that saw it still opens). This reconciler only
// reacts to failures that produced a failed REQUEST.

const DEFAULT_INTERVAL_MS = 15_000; // poll every 15s — fast fleet-wide reaction
const FAILURE_WINDOW_MS = 60_000; // count failures over the last minute
const FAILURE_THRESHOLD = 5; // open a provider at >= this many in-window failures
// The failover error codes that mean "upstream is down" (5xx/network/timeout/
// circuit-open) — NOT 4xx/quota, which are the caller's, not the host's health.
const UPSTREAM_DOWN_CODES = ['upstream_unreachable', 'upstream_unavailable'];

type ReconcilerTimer = ReturnType<typeof setInterval>;

const globalForBreakerReconciler = globalThis as typeof globalThis & {
  __kortixGatewayBreakerReconcilerTimer?: ReconcilerTimer | null;
};

let reconcilerTimer: ReconcilerTimer | null = null;
let reconcilerRunning = false;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intervalMs(): number {
  return positiveInt(process.env.KORTIX_GATEWAY_BREAKER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

export interface BreakerReconcileResult {
  opened: number;
  closed: number;
}

// One pass: tally upstream-down failures per provider, OPEN those over threshold,
// CLOSE any open provider that recovered. Exported for tests / manual invocation.
export async function reconcileGatewayBreakers(now = new Date()): Promise<BreakerReconcileResult> {
  const windowStart = new Date(now.getTime() - FAILURE_WINDOW_MS);

  const failures = await db
    .select({ provider: gatewayRequestLogs.provider, count: sql<number>`count(*)::int` })
    .from(gatewayRequestLogs)
    .where(
      and(
        eq(gatewayRequestLogs.ok, false),
        gt(gatewayRequestLogs.createdAt, windowStart),
        inArray(gatewayRequestLogs.errorCode, UPSTREAM_DOWN_CODES),
      ),
    )
    .groupBy(gatewayRequestLogs.provider);

  const down = new Map(
    failures.filter((f) => f.count >= FAILURE_THRESHOLD).map((f) => [f.provider, f.count] as const),
  );

  // Open (or refresh) every provider over threshold. Preserve the original
  // opened_at while it stays open; updated_at advances every tick so the store's
  // staleness guard keeps trusting the verdict.
  for (const [provider, count] of down) {
    await db
      .insert(gatewayBreakerState)
      .values({ provider, state: 'open', openedAt: now, failureCount: count, updatedAt: now })
      .onConflictDoUpdate({
        target: gatewayBreakerState.provider,
        set: {
          state: 'open',
          failureCount: count,
          updatedAt: now,
          openedAt: sql`case when ${gatewayBreakerState.state} = 'open' then ${gatewayBreakerState.openedAt} else now() end`,
        },
      });
  }

  // Close any provider currently open that's no longer over threshold (recovered).
  const openRows = await db
    .select({ provider: gatewayBreakerState.provider })
    .from(gatewayBreakerState)
    .where(eq(gatewayBreakerState.state, 'open'));

  let closed = 0;
  for (const row of openRows) {
    if (down.has(row.provider)) continue;
    await db
      .update(gatewayBreakerState)
      .set({ state: 'closed', failureCount: 0, openedAt: null, updatedAt: now })
      .where(eq(gatewayBreakerState.provider, row.provider));
    closed += 1;
  }

  return { opened: down.size, closed };
}

async function runBreakerReconciler(): Promise<void> {
  if (reconcilerRunning) return;
  reconcilerRunning = true;
  try {
    const result = await reconcileGatewayBreakers();
    if (result.opened || result.closed) {
      console.warn(
        `[gateway-breaker-reconciler] fleet breaker update: opened=${result.opened} closed=${result.closed}`,
      );
    }
  } finally {
    reconcilerRunning = false;
  }
}

export function startGatewayBreakerReconciler(): void {
  if (process.env.KORTIX_GATEWAY_BREAKER_RECONCILER_ENABLED === 'false') return;
  if (globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer) {
    clearInterval(globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer);
  }
  reconcilerTimer = setInterval(() => {
    runBreakerReconciler().catch((err) => {
      console.error('[gateway-breaker-reconciler] run failed:', err);
    });
  }, intervalMs());
  globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer = reconcilerTimer;
}

export function stopGatewayBreakerReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
  if (globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer) {
    clearInterval(globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer);
    globalForBreakerReconciler.__kortixGatewayBreakerReconcilerTimer = null;
  }
}
