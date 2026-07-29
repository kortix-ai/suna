/**
 * `kortix_api_token` — the credential the voice-agent worker (apps/voice-agent)
 * carries for one call, private dispatch metadata carrying it into `ctx.job.metadata`
 * at dispatch time (see that app's `call-context.ts`). It authenticates the
 * worker's `Authorization: Bearer` header on its single way in, the MCP at
 * `POST /v1/projects/:projectId/sessions/:sessionId/mcp/voice` (routes.ts).
 * (It used to guard three separate `/voice/{prompt,run-command,turns}` routes;
 * those are gone — the worker speaks JSON-RPC to the one route now.)
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
