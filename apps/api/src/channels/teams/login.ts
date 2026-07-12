import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface TeamsLoginStatePayload {
  tenantId: string;
  teamsUserId: string;
  pendingId?: string;
  exp: number;
  nonce: string;
}

function loginSigningKey(): string {
  return config.MICROSOFT_APP_PASSWORD ?? 'kortix-dev-teams-state-key';
}

export function signTeamsLoginState(input: {
  tenantId: string;
  teamsUserId: string;
  pendingId?: string;
}): string {
  const full: TeamsLoginStatePayload = {
    tenantId: input.tenantId,
    teamsUserId: input.teamsUserId,
    ...(input.pendingId ? { pendingId: input.pendingId } : {}),
    exp: Date.now() + LOGIN_TTL_MS,
    nonce: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const mac = createHmac('sha256', loginSigningKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyTeamsLoginState(token: string): TeamsLoginStatePayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', loginSigningKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TeamsLoginStatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.tenantId !== 'string' || typeof payload.teamsUserId !== 'string') return null;
    if (payload.pendingId !== undefined && typeof payload.pendingId !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildTeamsLoginUrl(input: {
  tenantId: string;
  teamsUserId: string;
  pendingId?: string;
}): string {
  const token = signTeamsLoginState(input);
  const apiBase = (config.KORTIX_URL || '').replace(/\/+$/, '');
  if (apiBase.startsWith('https://')) {
    return `${apiBase}/v1/channels/teams/identity/login/${token}`;
  }
  const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  return `${base}/teams/login/${token}`;
}
