import { config } from '../../config';
import { signChannelState, verifyChannelState } from '../core/signed-state';

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface TeamsLoginStatePayload {
  tenantId: string;
  teamsUserId: string;
  pendingId?: string;
  exp: number;
  nonce: string;
}

export function signTeamsLoginState(input: {
  tenantId: string;
  teamsUserId: string;
  pendingId?: string;
}): string {
  return signChannelState(
    'teams-login',
    {
      tenantId: input.tenantId,
      teamsUserId: input.teamsUserId,
      ...(input.pendingId ? { pendingId: input.pendingId } : {}),
    },
    LOGIN_TTL_MS,
  );
}

export function verifyTeamsLoginState(token: string): TeamsLoginStatePayload | null {
  const payload = verifyChannelState('teams-login', token);
  if (!payload) return null;
  if (typeof payload.tenantId !== 'string' || typeof payload.teamsUserId !== 'string') return null;
  if (payload.pendingId !== undefined && typeof payload.pendingId !== 'string') return null;
  return payload as unknown as TeamsLoginStatePayload;
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
