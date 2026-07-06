/**
 * A black-box re-implementation of `src/server/auth.ts`'s token scheme, used
 * ONLY to hand-craft edge-case tokens (expired, tampered) that a real login
 * flow can't produce on demand. Deliberately duplicated rather than imported
 * from app source — these tests exercise the app as an HTTP black box, and an
 * independent implementation is also a better regression check: if it and
 * `auth.ts` ever disagree, that's a real compatibility break, not a shared-bug
 * false negative.
 */

import { createHmac } from 'node:crypto';

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function craftToken(
  secret: string,
  userId: string,
  { iat, exp }: { iat: number; exp: number },
): string {
  const body = b64url(JSON.stringify({ userId, iat, exp }));
  return `${body}.${sign(secret, body)}`;
}

/** A validly-signed but already-expired token. */
export function expiredToken(secret: string, userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return craftToken(secret, userId, { iat: now - 1000, exp: now - 10 });
}

/** A well-formed, non-expired token signed with the WRONG secret (or tampered signature). */
export function tamperedToken(secret: string, userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const valid = craftToken(secret, userId, { iat: now, exp: now + 3600 });
  const dot = valid.indexOf('.');
  const body = valid.slice(0, dot);
  const sig = valid.slice(dot + 1);
  // Flip the last character of the signature (base64url alphabet-safe swap).
  const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
  return `${body}.${flipped}`;
}
