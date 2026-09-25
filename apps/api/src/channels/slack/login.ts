import { config } from '../../config';
import { signChannelState, verifyChannelState } from '../core/signed-state';

// Short-lived, integrity-protected token that round-trips a Slack user's
// identity through the `/login` web page. The payload (team + Slack user id) is
// not secret — it only needs to be unforgeable so a member can't bind someone
// else's Slack id to their Kortix account. See core/signed-state.ts for the key.

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface LoginStatePayload {
  teamId: string;
  slackUserId: string;
  pendingId?: string;
  exp: number;
  nonce: string;
}

export function signLoginState(input: { teamId: string; slackUserId: string; pendingId?: string }): string {
  return signChannelState(
    'slack-login',
    {
      teamId: input.teamId,
      slackUserId: input.slackUserId,
      ...(input.pendingId ? { pendingId: input.pendingId } : {}),
    },
    LOGIN_TTL_MS,
  );
}

export function verifyLoginState(token: string): LoginStatePayload | null {
  const payload = verifyChannelState('slack-login', token);
  if (!payload) return null;
  if (typeof payload.teamId !== 'string' || typeof payload.slackUserId !== 'string') return null;
  if (payload.pendingId !== undefined && typeof payload.pendingId !== 'string') return null;
  return payload as unknown as LoginStatePayload;
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
