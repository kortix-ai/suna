import { createHmac, timingSafeEqual } from 'node:crypto';

const FIVE_MINUTES_S = 5 * 60;

/**
 * Verify a Kortix WhatsApp Gateway webhook signature.
 *
 * The gateway signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the raw
 * `whsec_…` endpoint secret, hex-encoded, and sends it as
 * `x-whatsapp-signature: v1=<hex>` alongside `x-whatsapp-timestamp`.
 */
export function verifyWhatsAppSignature(input: {
  rawBody: string;
  secret: string;
  timestamp: string;
  signature: string;
}): boolean {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  // Reject replays outside the tolerance window.
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > FIVE_MINUTES_S) return false;

  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest('hex');

  for (const part of input.signature.split(/[\s,]+/)) {
    const value = part.startsWith('v1=') ? part.slice('v1='.length) : null;
    if (!value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
