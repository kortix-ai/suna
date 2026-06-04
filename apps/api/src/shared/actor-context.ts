import { createHmac, timingSafeEqual } from 'crypto';

export const ACTOR_CONTEXT_HEADER = 'X-Kortix-Actor-Context';

export interface ActorContext {
  sandboxId: string;
  userId: string;
  sessionId: string;
  iat: number;
  exp: number;
}

function base64urlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4);
  const padded = pad < 4 ? s + '='.repeat(pad) : s;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export type VerifyActorResult =
  | { ok: true; context: ActorContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' };

export function verifyActorContext(
  token: string | undefined | null,
  secret: string,
): VerifyActorResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };

  const expectedSig = base64urlEncode(
    createHmac('sha256', secret).update(payloadB64).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: ActorContext;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as ActorContext;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, context: payload };
}

export function resolveActorFromRequest(
  c: {
    req: { header: (name: string) => string | undefined };
    get: (key: 'sandboxId') => string | undefined;
  },
  options: { logPrefix?: string } = {},
): ActorContext | null {
  const raw = c.req.header(ACTOR_CONTEXT_HEADER);
  if (!raw) return null;
  const auth = c.req.header('Authorization') || c.req.header('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!bearer) return null;
  const result = verifyActorContext(raw, bearer);
  const prefix = options.logPrefix ?? '[ACTOR]';
  if (!result.ok) {
    console.warn(`${prefix} ignoring ${ACTOR_CONTEXT_HEADER} (${result.reason})`);
    return null;
  }
  const boundSandbox = c.get('sandboxId');
  if (boundSandbox && result.context.sandboxId !== boundSandbox) {
    console.warn(
      `${prefix} sandbox mismatch: claim=${result.context.sandboxId} bearer=${boundSandbox}`,
    );
    return null;
  }
  return result.context;
}
