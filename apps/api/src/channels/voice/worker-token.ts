/**
 * `kortix_api_token` — the credential the voice-agent worker (apps/voice-agent)
 * carries for one call, room metadata carrying it into `ctx.job.room.metadata`
 * at dispatch time (see that app's `call-context.ts`). It authenticates the
 * worker's `Authorization: Bearer` header on every `/voice/{prompt,run-command,
 * turns}` call (routes.ts).
 *
 * Deliberately NOT an encrypted envelope: there is no secret payload to
 * protect here, only a call id the worker already has. A plain HMAC over
 * `callId` is enough, stateless, and verifiable by any API instance without
 * a DB round trip — the one part of this flow that can't assume it's landing
 * on the process that holds the in-memory call registry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

export function mintCallApiToken(callId: string): string {
  return createHmac('sha256', config.API_KEY_SECRET).update(`voice-api:${callId}`).digest('hex');
}

export function verifyCallApiToken(callId: string, token: string | undefined | null): boolean {
  if (!callId || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(mintCallApiToken(callId));
  return a.length === b.length && timingSafeEqual(a, b);
}
