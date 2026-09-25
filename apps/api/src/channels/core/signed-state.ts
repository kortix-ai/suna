import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

/**
 * Short-lived signed tokens that carry chat-channel state through a browser:
 * the identity login links (`/login` in Slack or Teams) and the OAuth install
 * `state`. The payload is not secret. It must only be unforgeable.
 *
 * Every purpose has its own key, derived from `API_KEY_SECRET` (required at
 * boot), so a token minted for one purpose never verifies as another. Signing
 * throws without a key, and verifying answers null: an HMAC keyed with an
 * empty string is one anyone can compute.
 */
export type ChannelStatePurpose = 'slack-login' | 'teams-login' | 'slack-oauth' | 'teams-oauth';

export interface ChannelStateEnvelope {
  exp: number;
  nonce: string;
}

const keys = new Map<string, Buffer>();

function signingKey(purpose: ChannelStatePurpose): Buffer {
  const secret = config.API_KEY_SECRET;
  if (!secret) throw new Error(`API_KEY_SECRET must be configured to sign ${purpose} tokens`);
  const cacheKey = `${purpose}\u0000${secret}`;
  const cached = keys.get(cacheKey);
  if (cached) return cached;
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(`kortix-${purpose}-v1`, 'utf8'), 32),
  );
  keys.set(cacheKey, key);
  return key;
}

function mac(purpose: ChannelStatePurpose, body: string): string {
  return createHmac('sha256', signingKey(purpose)).update(body).digest('base64url');
}

export function signChannelState(
  purpose: ChannelStatePurpose,
  payload: Record<string, unknown>,
  ttlMs: number,
): string {
  const full = { ...payload, exp: Date.now() + ttlMs, nonce: randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${mac(purpose, body)}`;
}

/**
 * The payload of a token signed for `purpose`, or null when the token is
 * malformed, forged, expired, or no key is configured. Callers check the
 * shape of their own fields.
 */
export function verifyChannelState(
  purpose: ChannelStatePurpose,
  token: string | null | undefined,
): (Record<string, unknown> & ChannelStateEnvelope) | null {
  if (!token) return null;
  const [body, given] = token.split('.');
  if (!body || !given) return null;
  let expected: string;
  try {
    expected = mac(purpose, body);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.nonce !== 'string') return null;
    return payload as Record<string, unknown> & ChannelStateEnvelope;
  } catch {
    return null;
  }
}
