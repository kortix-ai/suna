import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { normalizeString } from './serializers';

/**
 * Who asked for this fire. `monitor` is the third trigger type's source:
 * the observer draining a monitor event
 * off `project_monitor_events`. It rides the identical downstream path as
 * `cron` — the session it mints is stamped `trigger:monitor`. `reminder` is a
 * session reminder's fire (`lib/session-reminders.ts`); it only re-prompts a session.
 */
export type TriggerFireSource = 'cron' | 'webhook' | 'manual' | 'monitor' | 'reminder';

export function normalizeSignatureHeader(value: string | null): string | null {
  const header = normalizeString(value);
  if (!header) return null;
  return header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
}

export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | null,
) {
  const signature = normalizeSignatureHeader(signatureHeader);
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

// Pull a static shared-secret token from a webhook request's headers, for
// sources that can't HMAC-sign the body (e.g. Better Stack error webhooks, which
// only allow custom headers / basic auth). Order: X-Kortix-Token, then
// Authorization (Bearer <token> or Basic <base64(user:token)> → password).
export function extractWebhookToken(
  kortixToken: string | null | undefined,
  authorization: string | null | undefined,
): string | null {
  if (kortixToken && kortixToken.trim()) return kortixToken.trim();
  if (authorization && authorization.trim()) {
    const trimmed = authorization.trim();
    const sep = trimmed.indexOf(' ');
    const scheme = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
    const value = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    if (scheme === 'bearer' && value) return value;
    if (scheme === 'basic' && value) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
        return password || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Static-token fallback auth (only consulted when no HMAC signature header is
// present). The token must equal the trigger's secret; constant-time compared.
export function verifyWebhookToken(token: string | null, secret: string): boolean {
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function parseWebhookJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}

export function webhookPayload(c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  return {
    body,
    headers: {
      content_type: c.req.header('content-type') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      forwarded_for: c.req.header('x-forwarded-for') ?? null,
    },
  };
}
