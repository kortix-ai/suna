/**
 * Provider sandbox-lifecycle webhook ingress — the DETERMINISTIC billing-close
 * path. The reaper sweep (projects/sandbox-reaper.ts) is the backstop; these
 * webhooks make billing close the instant a provider reports a box stopped,
 * instead of up to a sweep-interval later.
 *
 *  - Daytona: org-level webhook, events `sandbox.created` / `sandbox.state.updated`
 *    (payload carries `id`, `newState`). Deliveries are signed Svix-style
 *    (`webhook-id` / `webhook-timestamp` / `webhook-signature`, secret `whsec_…`).
 *  - Platinum: events `sandbox.created` / `sandbox.state_updated` / `sandbox.deleted`,
 *    each HMAC-SHA-256 signed with the per-webhook secret shown once at
 *    registration (`POST /v1/webhooks`).
 *
 * Signature header/format specifics for each provider are confirmed against a
 * live delivery at deploy time — see verify* below. Until the matching secret is
 * configured the endpoints are inert (503) and the reaper alone keeps billing
 * correct, so enabling webhooks is purely an upgrade in latency, never a
 * correctness dependency.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { recordWebhookEvent } from '../../billing/services/webhook-concurrency';
import {
  reconcileSandboxStoppedByExternalId,
  reconcileSandboxRemovedByExternalId,
} from '../../projects/sandbox-reaper';

export type SandboxLifecycleOutcome = 'stopped' | 'removed' | 'noop';
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Map a provider state / event name to the billing action. Only the terminal
 * directions matter for correctness — a `started`/`created`/transitional event
 * is acked as a no-op (our own resume/provision paths own the active direction).
 */
export function classifyLifecycle(state: string | undefined | null, eventType: string): SandboxLifecycleOutcome {
  const s = (state ?? '').toLowerCase();
  const e = (eventType ?? '').toLowerCase();
  if (e.includes('delet') || e.includes('destroy')) return 'removed';
  if (['destroyed', 'deleted', 'removed', 'lost', 'failed-start'].includes(s)) return 'removed';
  if (['stopped', 'archived'].includes(s)) return 'stopped';
  return 'noop';
}

/** Constant-time hex/base64 compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Plain HMAC-SHA-256 over the raw body (Platinum). Accepts the signature header
 * with or without a `sha256=` / `v1=` prefix, in hex.
 */
export function verifyHmacSha256(rawBody: string, secret: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // A header may carry multiple comma/space-separated candidates (`v1=…,…`).
  const candidates = headerValue
    .split(/[\s,]+/)
    .map((p) => p.replace(/^(sha256=|v1=)/i, '').trim())
    .filter(Boolean);
  return candidates.some((c) => safeEqual(c.toLowerCase(), expected.toLowerCase()));
}

/**
 * Svix-style verification (Daytona). signedContent = `${id}.${timestamp}.${body}`;
 * secret is base64 after the `whsec_` prefix; signature header is one or more
 * space-separated `v1,<base64>` entries.
 */
export function verifySvix(
  rawBody: string,
  secret: string,
  parts: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
): boolean {
  const { id, timestamp, signature } = parts;
  if (!id || !timestamp || !signature) return false;
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  const candidates = signature
    .split(' ')
    .map((p) => (p.includes(',') ? p.split(',')[1] : p))
    .filter(Boolean);
  return candidates.some((c) => safeEqual(c, expected));
}

/** Apply the terminal outcome to billing + DB (idempotent, shared with the reaper). */
export async function applySandboxLifecycle(
  externalId: string,
  outcome: SandboxLifecycleOutcome,
): Promise<{ action: SandboxLifecycleOutcome; changed: boolean }> {
  if (!externalId) return { action: 'noop', changed: false };
  if (outcome === 'stopped') {
    const changed = await reconcileSandboxStoppedByExternalId(externalId);
    return { action: 'stopped', changed };
  }
  if (outcome === 'removed') {
    const changed = await reconcileSandboxRemovedByExternalId(externalId);
    return { action: 'removed', changed };
  }
  return { action: 'noop', changed: false };
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Daytona webhook handler. `headers` is a case-insensitive getter. */
export async function handleDaytonaWebhook(
  rawBody: string,
  getHeader: (name: string) => string | undefined,
): Promise<WebhookResult> {
  const secret = config.DAYTONA_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'daytona webhook not configured' } };

  const ok = verifySvix(rawBody, secret, {
    id: getHeader('webhook-id') ?? getHeader('svix-id'),
    timestamp: getHeader('webhook-timestamp') ?? getHeader('svix-timestamp'),
    signature: getHeader('webhook-signature') ?? getHeader('svix-signature'),
  });
  if (!ok) return { status: 401, body: { error: 'invalid signature' } };

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const externalId: string | undefined = event?.id ?? event?.data?.id ?? event?.sandboxId;
  const eventType: string = event?.event ?? event?.type ?? '';
  const newState: string | undefined = event?.newState ?? event?.state ?? event?.data?.state;
  if (!externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const dedupId = `daytona:${getHeader('webhook-id') ?? `${externalId}:${eventType}:${newState}:${event?.updatedAt ?? ''}`}`;
  const fresh = await recordWebhookEvent(dedupId, eventType || 'sandbox.event').catch((err) => {
    console.warn('[sandbox-webhook] Daytona dedupe store unavailable:', err instanceof Error ? err.message : err);
    return null;
  });
  if (fresh == null) return { status: 503, body: { error: 'webhook dedupe unavailable' } };
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  const outcome = classifyLifecycle(newState, eventType);
  const res = await applySandboxLifecycle(externalId, outcome);
  return { status: 200, body: { ok: true, externalId, ...res } };
}

/** Platinum webhook handler. */
export async function handlePlatinumWebhook(
  rawBody: string,
  getHeader: (name: string) => string | undefined,
): Promise<WebhookResult> {
  const secret = config.PLATINUM_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'platinum webhook not configured' } };

  const sig =
    getHeader('x-platinum-signature') ??
    getHeader('platinum-signature') ??
    getHeader('x-signature') ??
    getHeader('webhook-signature');
  if (!verifyHmacSha256(rawBody, secret, sig)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const externalId: string | undefined = event?.id ?? event?.sandbox_id ?? event?.data?.id ?? event?.sandboxId;
  const eventType: string = event?.event ?? event?.type ?? '';
  const newState: string | undefined = event?.state ?? event?.new_state ?? event?.newState ?? event?.data?.state;
  if (!externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const deliveryId: string | undefined = event?.event_id ?? event?.delivery_id ?? event?.webhook_id ?? event?.data?.event_id;
  const dedupId = `platinum:${deliveryId ?? `${externalId}:${eventType}:${newState ?? ''}:${event?.timestamp ?? ''}`}`;
  const fresh = await recordWebhookEvent(dedupId, eventType || 'sandbox.event').catch((err) => {
    console.warn('[sandbox-webhook] Platinum dedupe store unavailable:', err instanceof Error ? err.message : err);
    return null;
  });
  if (fresh == null) return { status: 503, body: { error: 'webhook dedupe unavailable' } };
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  const outcome = classifyLifecycle(newState, eventType);
  const res = await applySandboxLifecycle(externalId, outcome);
  return { status: 200, body: { ok: true, externalId, ...res } };
}
