// Audit webhook delivery — fires HTTP POSTs to customer-configured URLs.
// The database trigger queues matching deliveries in the SAME transaction as
// each canonical event. The elected worker claims that durable queue with
// SKIP LOCKED, so slow or failed receivers never block the audit write path.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { auditEvents, auditWebhookDeliveries, auditWebhooks } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { accountHasEntitlement } from '../billing/services/entitlements';
import { assertAllowedSourceAddress } from '../marketplace/catalog';
import { serializeAuditEvent } from './audit-query';
import { auditWebhookFailureSummary } from './audit-webhook-privacy';
import { db } from './db';
import { safeEgressFetch } from './ssrf-guard';

/** Payload shape sent to the customer's webhook. Stable contract — bump
 *  schema_version if ever changing the shape. */
export interface AuditWebhookPayload {
  schema_version: 1;
  event: {
    event_id: string;
    occurred_at: string;
    account_id: string;
    project_id?: string | null;
    session_id?: string | null;
    actor_user_id: string | null;
    actor_type?: string | null;
    source?: string | null;
    outcome?: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    http_status?: number | null;
    duration_ms?: number | null;
    request_id?: string | null;
    trace_id?: string | null;
    correlation_id?: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ip: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown>;
  } & Record<string, unknown>;
}

export function generateWebhookSecret(): string {
  // 32 bytes → 64-char hex. Plenty of HMAC entropy.
  return `whsec_${randomBytes(32).toString('hex')}`;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Stable per-(webhook,event) idempotency key so a SIEM receiver can dedupe if
 *  the same event is ever delivered twice (e.g. a future retry). */
function idempotencyKeyFor(webhookId: string, eventId: string): string {
  return createHash('sha256').update(`${webhookId}:${eventId}`).digest('hex');
}

const DELIVERY_TIMEOUT_MS = 5_000;

/** Outcome of a single delivery attempt — surfaced to the create/test flow so
 *  an admin sees a broken URL immediately instead of an empty SIEM. */
export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_BATCH_SIZE = 50;
const WORKER_IDLE_MS = 2_000;
const WORKER_ERROR_MS = 5_000;
const WORKER_ID = `audit-webhook-${process.pid}-${randomBytes(4).toString('hex')}`;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerRunning = false;
let workerStopped = true;
let activeWorkerTick: Promise<void> | null = null;

interface ClaimedDelivery extends Record<string, unknown> {
  deliveryId: string;
}

async function claimDeliveries(): Promise<string[]> {
  const rows = await db.execute<ClaimedDelivery>(sql`
    WITH picked AS (
      SELECT delivery_id
      FROM kortix.audit_webhook_deliveries
      WHERE (
          (status IN ('pending', 'retry') AND next_attempt_at <= now())
          OR (status = 'delivering' AND locked_until < now())
        )
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY next_attempt_at, created_at
      LIMIT ${DELIVERY_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE kortix.audit_webhook_deliveries d
       SET status = 'delivering', locked_by = ${WORKER_ID},
           locked_until = now() + interval '30 seconds', updated_at = now()
      FROM picked
     WHERE d.delivery_id = picked.delivery_id
    RETURNING d.delivery_id AS "deliveryId"
  `);
  return Array.from(rows as unknown as ClaimedDelivery[]).map((row) => row.deliveryId);
}

function retryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

async function processDelivery(deliveryId: string): Promise<void> {
  const [row] = await db
    .select({ delivery: auditWebhookDeliveries, hook: auditWebhooks, event: auditEvents })
    .from(auditWebhookDeliveries)
    .innerJoin(auditWebhooks, eq(auditWebhooks.webhookId, auditWebhookDeliveries.webhookId))
    .innerJoin(auditEvents, eq(auditEvents.eventId, auditWebhookDeliveries.eventId))
    .where(
      and(
        eq(auditWebhookDeliveries.deliveryId, deliveryId),
        eq(auditWebhookDeliveries.lockedBy, WORKER_ID),
      ),
    )
    .limit(1);
  if (!row) return;

  let entitled = false;
  try {
    entitled =
      !!row.event.accountId && (await accountHasEntitlement(row.event.accountId, 'auditAccess'));
  } catch {
    entitled = false;
  }
  if (!entitled || !row.hook.enabled) {
    await db
      .update(auditWebhookDeliveries)
      .set({
        status: 'dead_letter',
        lockedBy: null,
        lockedUntil: null,
        lastError: entitled ? 'webhook disabled' : 'audit entitlement unavailable',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(auditWebhookDeliveries.deliveryId, deliveryId),
          eq(auditWebhookDeliveries.lockedBy, WORKER_ID),
        ),
      );
    return;
  }

  const event = serializeAuditEvent(row.event);
  const payload = { schema_version: 1 as const, event };
  const result = await deliverOne(
    row.hook,
    JSON.stringify(payload),
    idempotencyKeyFor(row.hook.webhookId, row.event.eventId),
  );
  const attempts = row.delivery.attempts + 1;
  if (result.ok) {
    await db
      .update(auditWebhookDeliveries)
      .set({
        status: 'delivered',
        attempts,
        lastStatus: result.status ?? null,
        lastError: null,
        deliveredAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(auditWebhookDeliveries.deliveryId, deliveryId),
          eq(auditWebhookDeliveries.lockedBy, WORKER_ID),
        ),
      );
    return;
  }
  const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
  await db
    .update(auditWebhookDeliveries)
    .set({
      status: dead ? 'dead_letter' : 'retry',
      attempts,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
      lastStatus: result.status ?? null,
      lastError: result.error?.slice(0, 1000) ?? 'delivery failed',
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(auditWebhookDeliveries.deliveryId, deliveryId),
        eq(auditWebhookDeliveries.lockedBy, WORKER_ID),
      ),
    );
}

async function workerTick(): Promise<void> {
  if (workerRunning || workerStopped) return;
  workerRunning = true;
  try {
    const ids = await claimDeliveries();
    await Promise.all(ids.map(processDelivery));
    scheduleWorker(ids.length > 0 ? 0 : WORKER_IDLE_MS);
  } catch (error) {
    console.warn('[audit-webhook] worker tick failed', error);
    scheduleWorker(WORKER_ERROR_MS);
  } finally {
    workerRunning = false;
  }
}

function scheduleWorker(delay: number): void {
  if (workerStopped || workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    const tick = workerTick();
    activeWorkerTick = tick;
    void tick.finally(() => {
      if (activeWorkerTick === tick) activeWorkerTick = null;
    });
  }, delay);
  workerTimer.unref?.();
}

export function startAuditWebhookWorker(): void {
  if (!workerStopped) return;
  workerStopped = false;
  scheduleWorker(0);
}

export async function stopAuditWebhookWorker(): Promise<void> {
  workerStopped = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  await activeWorkerTick;
}

export async function replayAuditWebhookDelivery(
  deliveryId: string,
  webhookId: string,
): Promise<boolean> {
  const rows = await db
    .update(auditWebhookDeliveries)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      lastStatus: null,
      lastError: null,
      deliveredAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(auditWebhookDeliveries.deliveryId, deliveryId),
        eq(auditWebhookDeliveries.webhookId, webhookId),
      ),
    )
    .returning({ deliveryId: auditWebhookDeliveries.deliveryId });
  if (rows.length > 0) scheduleWorker(0);
  return rows.length > 0;
}

/**
 * Send one payload to one webhook, stamping last_delivered_at / last_error on
 * the row, and RETURN the outcome so the caller (a create-time test) can react.
 * Never throws — the audit path must not blow up on a bad receiver.
 */
async function deliverOne(
  hook: typeof auditWebhooks.$inferSelect,
  body: string,
  idempotencyKey: string,
): Promise<DeliveryResult> {
  // SSRF guard: re-check at delivery time too, not just at create. Covers
  // rows written before this guard existed and DNS-rebinding-style TOCTOU
  // against the write-time check (write-time validation of the string can't
  // catch a hostname that later resolves to a private/internal address).
  try {
    assertAllowedSourceAddress(hook.url);
  } catch (err) {
    const msg = auditWebhookFailureSummary(
      'blocked',
      err instanceof Error ? err.message : String(err),
    );
    await recordFailure(hook.webhookId, msg);
    return { ok: false, error: msg };
  }

  const signature = sign(hook.secret, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const res = await safeEgressFetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Stripe-style signature header. Customers verify by recomputing
        // HMAC-SHA256(secret, raw_body) and comparing.
        'X-dosco-Signature': `sha256=${signature}`,
        'X-dosco-Webhook-Id': hook.webhookId,
        // Stable per-event key so receivers can dedupe on any re-delivery.
        'X-dosco-Idempotency-Key': idempotencyKey,
        'X-dosco-Event': 'audit',
        'User-Agent': 'dosco-Audit-Webhook/1',
      },
      body,
      signal: controller.signal,
      // Audit-webhook URLs are customer-supplied and may legitimately be http
      // on internal deployments; the SSRF DNS guard still applies.
      allowHttp: true,
    });

    if (res.ok) {
      // Cheap upsert of just the success timestamp — keeps last_error in
      // place so the admin can see the most-recent failure even after a
      // recovery, until the next failure overwrites it.
      await db
        .update(auditWebhooks)
        .set({ lastDeliveredAt: new Date() })
        .where(eq(auditWebhooks.webhookId, hook.webhookId));
      return { ok: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    const error = auditWebhookFailureSummary('http', text, res.status);
    await recordFailure(hook.webhookId, error);
    return { ok: false, status: res.status, error };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout after ${DELIVERY_TIMEOUT_MS}ms`
        : auditWebhookFailureSummary('network', raw);
    await recordFailure(hook.webhookId, msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire a synthetic `webhook.test` event at a webhook and report the outcome.
 * Called right after a webhook is created so a mistyped SIEM URL surfaces
 * immediately ("Test delivery failed: HTTP 404") instead of silently 404-ing
 * every real audit event until someone notices an empty dashboard. Stamps the
 * same last_delivered_at / last_error as a real delivery.
 */
export async function deliverTestEvent(
  hook: typeof auditWebhooks.$inferSelect,
): Promise<DeliveryResult> {
  const eventId = `test_${hook.webhookId}`;
  const payload: AuditWebhookPayload = {
    schema_version: 1,
    event: {
      event_id: eventId,
      occurred_at: new Date().toISOString(),
      account_id: hook.accountId,
      actor_user_id: null,
      action: 'webhook.test',
      resource_type: 'audit_webhook',
      resource_id: hook.webhookId,
      before: null,
      after: {
        message:
          'Test delivery from dosco. If your endpoint received this, audit events will stream here.',
      },
      ip: null,
      user_agent: null,
      metadata: { test: true },
    },
  };
  return deliverOne(hook, JSON.stringify(payload), idempotencyKeyFor(hook.webhookId, eventId));
}

async function recordFailure(webhookId: string, error: string): Promise<void> {
  try {
    await db
      .update(auditWebhooks)
      .set({ lastErrorAt: new Date(), lastError: error })
      .where(eq(auditWebhooks.webhookId, webhookId));
  } catch (err) {
    console.warn('[audit-webhook] failed to record failure', err);
  }
}
