import { gatewayRequestLogs, usageEvents } from '@kortix/db';
import type { BillingMode, UsageEvent } from '@kortix/llm-gateway';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { recordGatewayUsage } from '../../llm-gateway/hooks';
import { db } from '../../shared/db';

// ─── Usage reconciler (durable billing backstop) ────────────────────────────
//
// settle() in the gateway pipeline is fire-and-forget and recordUsage's insert +
// debit are non-transactional. A crash / connection drop between writing the
// trace (gateway_request_logs) and writing the usage_events row would silently
// lose the debit — revenue leak. This worker is the backstop: it scans for
// SUCCESSFUL, BILLABLE gateway turns (ok=true, finalCost>0) that have NO matching
// usage_events row and replays recordGatewayUsage for them.
//
// The replay is IDEMPOTENT via the usage_events.request_id UNIQUE index: the first
// replay inserts the row (inserted=true → debit), any concurrent/duplicate replay
// hits the conflict (inserted=false → no debit). So this can never double-charge,
// even if it overlaps with a slow in-flight settle of the same request.
//
// Leader-gated (registered in index.ts startSingletonWorkers), so exactly one
// replica runs it — mirrors projects/maintenance.ts.

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000; // every 3 min
const BATCH_SIZE = 200; // bounded per tick — back-pressure over a backlog
// Don't touch rows younger than this: a streaming turn's settle() writes the
// trace then the usage row, but both are async/best-effort, so a brief grace
// window avoids racing a settle that is legitimately still completing.
const SETTLE_GRACE_MS = 2 * 60 * 1000;
// Don't replay ancient rows — a multi-day-old miss is for manual/ops backfill,
// not the steady-state crash backstop. Bounds the scan and the blast radius.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

type ReconcilerTimer = ReturnType<typeof setInterval>;

const globalForUsageReconciler = globalThis as typeof globalThis & {
  __kortixUsageReconcilerTimer?: ReconcilerTimer | null;
};

let reconcilerTimer: ReconcilerTimer | null = null;
let reconcilerRunning = false;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intervalMs(): number {
  return positiveInt(process.env.KORTIX_USAGE_RECONCILER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

export interface ReconcileResult {
  candidates: number;
  replayed: number;
  errors: number;
}

// One pass: find ok+billable gateway logs with no usage_events row and replay
// recordGatewayUsage (idempotent). Exported for tests / manual invocation.
export async function reconcileGatewayUsage(now = new Date()): Promise<ReconcileResult> {
  const graceCutoff = new Date(now.getTime() - SETTLE_GRACE_MS);
  const lookbackCutoff = new Date(now.getTime() - LOOKBACK_MS);

  // LEFT JOIN usage_events on request_id; isNull(eventId) keeps only the gateway
  // turns that never recorded usage. Both columns are UNIQUE-indexed on request_id.
  const rows = await db
    .select({
      requestId: gatewayRequestLogs.requestId,
      accountId: gatewayRequestLogs.accountId,
      actorUserId: gatewayRequestLogs.actorUserId,
      projectId: gatewayRequestLogs.projectId,
      sessionId: gatewayRequestLogs.sessionId,
      provider: gatewayRequestLogs.provider,
      resolvedModel: gatewayRequestLogs.resolvedModel,
      inputTokens: gatewayRequestLogs.inputTokens,
      outputTokens: gatewayRequestLogs.outputTokens,
      cachedTokens: gatewayRequestLogs.cachedTokens,
      upstreamCost: gatewayRequestLogs.upstreamCost,
      finalCost: gatewayRequestLogs.finalCost,
      billingMode: gatewayRequestLogs.billingMode,
      streaming: gatewayRequestLogs.streaming,
      metadata: gatewayRequestLogs.metadata,
    })
    .from(gatewayRequestLogs)
    .leftJoin(usageEvents, eq(usageEvents.requestId, gatewayRequestLogs.requestId))
    .where(
      and(
        eq(gatewayRequestLogs.ok, true),
        // A real, lost debit: priced turn (finalCost>0) on a billable route.
        sql`${gatewayRequestLogs.finalCost} > 0`,
        sql`${gatewayRequestLogs.billingMode} is not null and ${gatewayRequestLogs.billingMode} <> 'none'`,
        lt(gatewayRequestLogs.createdAt, graceCutoff),
        gt(gatewayRequestLogs.createdAt, lookbackCutoff),
        isNull(usageEvents.eventId),
      ),
    )
    .limit(BATCH_SIZE);

  let replayed = 0;
  let errors = 0;

  for (const row of rows) {
    const event: UsageEvent = {
      accountId: row.accountId,
      actorUserId: row.actorUserId ?? '',
      projectId: row.projectId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      provider: row.provider,
      model: row.resolvedModel,
      promptTokens: row.inputTokens ?? 0,
      completionTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      upstreamCost: Number(row.upstreamCost ?? 0),
      finalCost: Number(row.finalCost ?? 0),
      billingMode: (row.billingMode ?? 'credits') as BillingMode,
      streaming: row.streaming ?? false,
      requestId: row.requestId,
      unpriced:
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>).unpriced === true
          : undefined,
    };
    try {
      // Idempotent: recordUsageEvent's onConflictDoNothing on request_id means a
      // row that was actually written between the scan and now is a no-op (no
      // second debit). Only a genuine miss inserts + debits.
      await recordGatewayUsage(event);
      replayed += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `[usage-reconciler] replay failed for request ${row.requestId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { candidates: rows.length, replayed, errors };
}

async function runUsageReconciler(): Promise<void> {
  if (reconcilerRunning) return;
  reconcilerRunning = true;
  try {
    const result = await reconcileGatewayUsage();
    if (result.replayed || result.errors) {
      console.warn(
        `[usage-reconciler] backfilled lost LLM usage: replayed=${result.replayed} errors=${result.errors} (of ${result.candidates} candidates)`,
      );
    }
  } finally {
    reconcilerRunning = false;
  }
}

export function startUsageReconciler(): void {
  if (process.env.KORTIX_USAGE_RECONCILER_ENABLED === 'false') return;
  if (globalForUsageReconciler.__kortixUsageReconcilerTimer) {
    clearInterval(globalForUsageReconciler.__kortixUsageReconcilerTimer);
  }
  reconcilerTimer = setInterval(() => {
    runUsageReconciler().catch((err) => {
      console.error('[usage-reconciler] run failed:', err);
    });
  }, intervalMs());
  globalForUsageReconciler.__kortixUsageReconcilerTimer = reconcilerTimer;
}

export function stopUsageReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
  if (globalForUsageReconciler.__kortixUsageReconcilerTimer) {
    clearInterval(globalForUsageReconciler.__kortixUsageReconcilerTimer);
    globalForUsageReconciler.__kortixUsageReconcilerTimer = null;
  }
}
