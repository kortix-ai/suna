import { createHmac, hkdfSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from '../../config';

// Short-lived, integrity-protected token that round-trips a Slack user's
// identity through the `/login` web page. The payload (team + Slack user id) is
// not secret — it only needs to be unforgeable so a member can't bind someone
// else's Slack id to their Kortix account. Same HMAC construction as the Slack
// OAuth `state` token (slack-oauth.ts).
//
// The key is derived from API_KEY_SECRET, which every API process must have to
// boot. It used to be the canonical Slack signing secret, which is empty on a
// deployment without the canonical Slack app — and an HMAC keyed with '' is
// one anyone can compute. Signing and verifying now refuse to run without a key.

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface LoginStatePayload {
  teamId: string;
  slackUserId: string;
  pendingId?: string;
  exp: number;
  nonce: string;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

export function loginSigningKey(): Buffer {
  const secret = config.API_KEY_SECRET;
  if (!secret) {
    throw new Error('API_KEY_SECRET must be configured for Slack login token signing');
  }
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('kortix-slack-login-v1', 'utf8'), 32),
  );
  cachedKey = { secret, key };
  return key;
}

export function signLoginState(input: { teamId: string; slackUserId: string; pendingId?: string }): string {
  const full: LoginStatePayload = {
    teamId: input.teamId,
    slackUserId: input.slackUserId,
    ...(input.pendingId ? { pendingId: input.pendingId } : {}),
    exp: Date.now() + LOGIN_TTL_MS,
    nonce: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const mac = createHmac('sha256', loginSigningKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyLoginState(token: string): LoginStatePayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  let key: Buffer;
  try {
    key = loginSigningKey();
  } catch {
    return null;
  }
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LoginStatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.teamId !== 'string' || typeof payload.slackUserId !== 'string') return null;
    if (payload.pendingId !== undefined && typeof payload.pendingId !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSlackLoginUrl(input: { teamId: string; slackUserId: string; pendingId?: string }): string {
  const token = signLoginState(input);
  const apiBase = (config.KORTIX_URL || '').replace(/\/+$/, '');
  if (apiBase.startsWith('https://')) {
    return `${apiBase}/v1/channels/slack/identity/login/${token}`;
  }

  const configured = config.FRONTEND_URL || 'https://kortix.com';
  const apiPort = Number(process.env.PORT);
  const localWorktreeFrontend =
    configured === 'http://localhost:3000' &&
    process.env.KORTIX_LOCAL_DEV === '1' &&
    Number.isFinite(apiPort) &&
    apiPort >= 10_000
      ? `http://localhost:${apiPort - 8}`
      : configured;
  const base = localWorktreeFrontend.replace(/\/+$/, '');
  return `${base}/slack/login/${token}`;
}
