import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export interface SessionConnectorTokenContext {
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

export function encodeSessionConnectorToken(
  ctx: Omit<SessionConnectorTokenContext, 'iat' | 'exp'> & { ttlSeconds?: number },
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ctx.ttlSeconds ?? 60 * 60);
  const payload: SessionConnectorTokenContext = {
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

export type VerifySessionConnectorTokenResult =
  | { ok: true; context: SessionConnectorTokenContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' };

export function verifySessionConnectorToken(token: string | undefined | null): VerifySessionConnectorTokenResult {
  if (!token) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature || parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(payloadB64);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionConnectorTokenContext;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as SessionConnectorTokenContext;
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
