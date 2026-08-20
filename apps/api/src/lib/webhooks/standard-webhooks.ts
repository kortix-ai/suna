// Standard Webhooks (standardwebhooks.com) signature verification.
//
// Two senders reach this API with that scheme — AgentMail (inbound email) and
// Supabase Auth (the send-email hook) — so the HMAC comparison lives in one
// place instead of once per integration. Both accept the legacy `svix-*`
// header names as well as the standardized `webhook-*` ones.
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_S = 5 * 60;

export interface StandardWebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

/**
 * Verify a Standard Webhooks signature over the RAW request body.
 *
 * `secret` accepts `whsec_<base64>`, a bare base64 secret, or the
 * `v1,whsec_<base64>` form Supabase writes for auth hooks. Several
 * space-separated secrets are accepted so a secret can be rotated without
 * downtime; the signature only has to match one.
 */
export function verifyStandardWebhook(input: {
  rawBody: string;
  secret: string;
  headers: StandardWebhookHeaders;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_S;
  const ts = Number(input.headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - ts) > tolerance) return false;

  const keys = decodeSecrets(input.secret);
  if (!keys.length) return false;

  const signed = `${input.headers.id}.${input.headers.timestamp}.${input.rawBody}`;
  const expected = keys.map((key) => createHmac('sha256', key).update(signed).digest('base64'));

  for (const part of input.headers.signature.split(/\s+/)) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    for (const candidate of expected) {
      const a = Buffer.from(sig);
      const b = Buffer.from(candidate);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

/**
 * Decode one or more signing secrets. Supabase stores auth-hook secrets as
 * `v1,whsec_<base64>`; Svix-style senders use a bare `whsec_<base64>`.
 */
export function decodeSecrets(secret: string): Buffer[] {
  const keys: Buffer[] = [];
  for (const entry of (secret || '').split(/\s+/)) {
    const value = entry.trim();
    if (!value) continue;
    // Strip an optional `v<n>,` version prefix, then an optional `whsec_`.
    const withoutVersion = value.replace(/^v\d+,/, '');
    const raw = withoutVersion.startsWith('whsec_')
      ? withoutVersion.slice('whsec_'.length)
      : withoutVersion;
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length) keys.push(decoded);
    } catch {
      // Skip an undecodable secret rather than failing the whole set.
    }
  }
  return keys;
}

/** Read the signature headers under either the standard or legacy names. */
export function readStandardWebhookHeaders(
  get: (name: string) => string | undefined,
): StandardWebhookHeaders {
  return {
    id: get('webhook-id') ?? get('svix-id') ?? '',
    timestamp: get('webhook-timestamp') ?? get('svix-timestamp') ?? '',
    signature: get('webhook-signature') ?? get('svix-signature') ?? '',
  };
}
