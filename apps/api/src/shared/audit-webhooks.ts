// Audit webhook delivery — fires HTTP POSTs to customer-configured URLs
// after every recordAuditEvent. Decoupled from the audit write path: the
// publisher returns immediately and dispatch happens on a microtask, so
// audit writes are never blocked by slow webhook endpoints.

import { createHmac, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditWebhooks } from '@kortix/db';
import { db } from './db';

/** Payload shape sent to the customer's webhook. Stable contract — bump
 *  schema_version if ever changing the shape. */
interface AuditWebhookPayload {
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

const DELIVERY_TIMEOUT_MS = 5_000;

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
      .where(
        and(eq(auditWebhooks.accountId, accountId), eq(auditWebhooks.enabled, true)),
      );
  } catch (err) {
    // Don't blow up if the table doesn't exist yet (fresh dev DB pre-migration).
    if (err instanceof Error && /relation .* does not exist/i.test(err.message)) return;
    throw err;
  }
  if (hooks.length === 0) return;

  // Filter by action prefix if the hook is restricted.
  const matches = hooks.filter(
    (h) => !h.actionPrefix || payload.event.action.startsWith(h.actionPrefix),
  );

  const body = JSON.stringify(payload);
  await Promise.all(matches.map((h) => deliverOne(h, body)));
}

async function deliverOne(
  hook: typeof auditWebhooks.$inferSelect,
  body: string,
): Promise<void> {
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
    } else {
      const text = await res.text().catch(() => '');
      await recordFailure(hook.webhookId, `HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordFailure(hook.webhookId, msg.slice(0, 500));
  } finally {
    clearTimeout(timer);
  }
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
