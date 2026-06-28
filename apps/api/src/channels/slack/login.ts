import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from '../../config';

// Short-lived, integrity-protected token that round-trips a Slack user's
// identity through the `/login` web page. The payload (team + Slack user id) is
// not secret — it only needs to be unforgeable so a member can't bind someone
// else's Slack id to their Kortix account. Same HMAC construction as the Slack
// OAuth `state` token (slack-oauth.ts); keyed off the canonical signing secret.

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface LoginStatePayload {
  teamId: string;
  slackUserId: string;
  pendingId?: string;
  exp: number;
  nonce: string;
}

function loginSigningKey(): string {
  return config.SLACK_SIGNING_SECRET ?? 'kortix-dev-state-key';
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
  const expected = createHmac('sha256', loginSigningKey()).update(body).digest('base64url');
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
