// Audit webhook delivery — fires HTTP POSTs to customer-configured URLs
// after every recordAuditEvent. Decoupled from the audit write path: the
// publisher returns immediately and dispatch happens on a microtask, so
// audit writes are never blocked by slow webhook endpoints.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { auditWebhooks } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { accountHasEntitlement } from '../billing/services/entitlements';
import { db } from './db';

/** Payload shape sent to the customer's webhook. Stable contract — bump
 *  schema_version if ever changing the shape. */
export interface AuditWebhookPayload {
  schema_version: 1;
  event: {
    event_id: string;
    occurred_at: string;
    account_id: string;
    actor_user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ip: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown>;
  };
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

/**
 * Look up enabled webhooks for the account and dispatch this event to each.
 * Returns immediately; deliveries run on the next microtask. Failures
 * update last_error / last_error_at on the webhook row so admins can see
 * them in the UI without us needing a separate deliveries table.
 *
 * Safe to call from inside recordAuditEvent — never throws, never blocks.
 */
export function dispatchAuditEvent(payload: AuditWebhookPayload): void {
  // Schedule but don't await — we want recordAuditEvent to return ASAP.
  void deliverAll(payload).catch((err) => {
    console.warn('[audit-webhook] dispatch failure', err);
  });
}

async function deliverAll(payload: AuditWebhookPayload): Promise<void> {
  const accountId = payload.event.account_id;
  let hooks;
  try {
    hooks = await db
      .select()
      .from(auditWebhooks)
      .where(and(eq(auditWebhooks.accountId, accountId), eq(auditWebhooks.enabled, true)));
  } catch (err) {
    // Don't blow up if the table doesn't exist yet (fresh dev DB pre-migration).
    if (err instanceof Error && /relation .* does not exist/i.test(err.message)) return;
    throw err;
  }
  if (hooks.length === 0) return;

  // Entitlement gate on the DATA PLANE, not just the management routes: a
  // downgraded account's leftover webhook rows must stop streaming the audit
  // feed. Checked only when the account actually has enabled hooks, so the
  // common no-webhook case pays nothing. Fail closed on lookup errors —
  // a webhook missing one event beats leaking audit data.
  try {
    if (!(await accountHasEntitlement(accountId, 'auditAccess'))) return;
  } catch {
    return;
  }

  // Filter by action prefix if the hook is restricted.
  const matches = hooks.filter(
    (h) => !h.actionPrefix || payload.event.action.startsWith(h.actionPrefix),
  );

  const body = JSON.stringify(payload);
  const eventId = payload.event.event_id;
  await Promise.all(
    matches.map((h) => deliverOne(h, body, idempotencyKeyFor(h.webhookId, eventId))),
  );
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
  const signature = sign(hook.secret, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Stripe-style signature header. Customers verify by recomputing
        // HMAC-SHA256(secret, raw_body) and comparing.
        'X-Kortix-Signature': `sha256=${signature}`,
        'X-Kortix-Webhook-Id': hook.webhookId,
        // Stable per-event key so receivers can dedupe on any re-delivery.
        'X-Kortix-Idempotency-Key': idempotencyKey,
        'X-Kortix-Event': 'audit',
        'User-Agent': 'Kortix-Audit-Webhook/1',
      },
      body,
      signal: controller.signal,
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
    const error = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    await recordFailure(hook.webhookId, error);
    return { ok: false, status: res.status, error };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
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
          'Test delivery from Kortix. If your endpoint received this, audit events will stream here.',
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
