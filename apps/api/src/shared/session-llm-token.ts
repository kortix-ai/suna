import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export interface SessionLlmTokenContext {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  iat: number;
  exp: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function sign(payloadB64: string): string {
  return base64urlEncode(
    createHmac('sha256', config.API_KEY_SECRET)
      .update(payloadB64)
      .digest(),
  );
}

export function encodeSessionLlmToken(
  ctx: Omit<SessionLlmTokenContext, 'iat' | 'exp'> & { ttlSeconds?: number },
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ctx.ttlSeconds ?? 60 * 60);
  const payload: SessionLlmTokenContext = {
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    iat,
    exp,
  };
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export type VerifySessionLlmTokenResult =
  | { ok: true; context: SessionLlmTokenContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' };

export function verifySessionLlmToken(token: string | undefined | null): VerifySessionLlmTokenResult {
  if (!token) return { ok: false, reason: 'malformed' };
  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature || token.split('.').length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionLlmTokenContext;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as SessionLlmTokenContext;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  if (!payload.accountId || !payload.projectId || !payload.sessionId || !payload.userId) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, context: payload };
}
