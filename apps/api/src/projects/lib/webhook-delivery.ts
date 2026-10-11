/**
 * One webhook delivery runs once, and only once per event (KRTX-1735).
 *
 * A delivery is keyed on the EVENT when the sender names one: our own
 * `X-Kortix-Delivery-Id`, or the per-event id a common sender keeps across its
 * retries. `X-Request-Id` names one HTTP attempt, so a sender's retry would
 * run twice; it is not an event id. Without an event id the key is the body
 * and its signature, and two identical deliveries are one event only inside
 * `WEBHOOK_REPLAY_WINDOW_MS`: a CI job that posts the same static body on
 * every deploy runs on every deploy.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export const WEBHOOK_DELIVERY_ID_HEADERS = [
  'x-kortix-delivery-id',
  'x-github-delivery',
  'x-gitlab-event-uuid',
  'linear-delivery',
  // Standard Webhooks, and Svix that implements it.
  'webhook-id',
  'svix-id',
] as const;

export const WEBHOOK_REPLAY_WINDOW_MS = 10 * 60_000;

export function webhookDeliveryKey(input: {
  projectId: string;
  slug: string;
  header: (name: string) => string | undefined;
  rawBody: string;
  signatureHeader: string | null;
  staticAuthFingerprint: string;
}): { key: string; byEvent: boolean } {
  const prefix = `trigger:webhook:${input.projectId}:${input.slug}:`;
  for (const name of WEBHOOK_DELIVERY_ID_HEADERS) {
    const id = input.header(name)?.trim();
    if (id) return { key: prefix + id, byEvent: true };
  }
  const hash = createHash('sha256')
    .update(input.rawBody)
    .update(input.signatureHeader ?? '')
    .update(input.staticAuthFingerprint)
    .digest('hex');
  return { key: prefix + hash, byEvent: false };
}

/**
 * Free a delivery key whose earlier command can no longer answer for it, so
 * this delivery runs:
 * - the command dead-lettered (out of credits, a plan gate): a redelivery
 *   after the fix must run, not replay the old failure;
 * - its session was deleted: a redelivery starts a new session, not a 409;
 * - for a body-hash key only, the command is older than the replay window.
 *
 * The old row keeps its history under `<key>:released:<command_id>`. A command
 * still queued or running keeps its key: that delivery is in flight.
 */
export async function releaseWebhookDeliveryKey(key: string, opts: { byEvent: boolean }): Promise<number> {
  const windowStart = new Date(Date.now() - WEBHOOK_REPLAY_WINDOW_MS).toISOString();
  const rows = (await db.execute(sql`
    UPDATE kortix.session_lifecycle_commands c
       SET idempotency_key = c.idempotency_key || ':released:' || c.command_id::text,
           updated_at = now()
     WHERE c.idempotency_key = ${key}
       AND c.status NOT IN ('queued', 'running')
       AND (
         c.status = 'dead_lettered'
         OR EXISTS (
           SELECT 1 FROM kortix.project_sessions s
            WHERE s.session_id = c.session_id AND (s.metadata ->> 'deletedAt') IS NOT NULL
         )
         OR (${!opts.byEvent} AND c.created_at < ${windowStart}::timestamptz)
       )
    RETURNING c.command_id`)) as unknown as unknown[];
  return rows.length;
}
