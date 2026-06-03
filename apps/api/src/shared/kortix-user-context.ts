/**
 * Signed user-context header sent from the preview proxy to kortix-master.
 *
 * Format: `<base64url(json payload)>.<base64url(HMAC-SHA256)>`
 *
 * Kortix-master owns the same secret (the sandbox's KORTIX_TOKEN service key)
 * and verifies the signature locally — no callback to the Kortix API per
 * request. An `exp` field bounds staleness after ACL changes.
 *
 * Keep this module pure so the sandbox-side verifier can mirror the same
 * serialization format without depending on anything platform-specific.
 */

import { createHmac } from 'crypto';

export const KORTIX_USER_CONTEXT_HEADER = 'X-Kortix-User-Context';

/** TTL for a signed context — short enough that revocations take effect quickly. */
const KORTIX_USER_CONTEXT_TTL_SECONDS = 60;

export interface KortixUserContext {
  userId: string;
  sandboxId: string;
  sandboxRole: 'owner' | 'admin' | 'member' | 'platform_admin';
  scopes: string[];
  iat: number;
  exp: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadB64: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(payloadB64).digest();
  return base64urlEncode(mac);
}

export function encodeKortixUserContext(
  ctx: Omit<KortixUserContext, 'iat' | 'exp'> & { ttlSeconds?: number },
  secret: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ctx.ttlSeconds ?? KORTIX_USER_CONTEXT_TTL_SECONDS);
  const payload: KortixUserContext = {
    userId: ctx.userId,
    sandboxId: ctx.sandboxId,
    sandboxRole: ctx.sandboxRole,
    scopes: ctx.scopes ?? [],
    iat,
    exp,
  };
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}
