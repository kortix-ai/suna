import type { Effect } from 'effect';
import { OPENCODE_USER_AGENT } from '@kortix/shared';

export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_USER_AGENT = OPENCODE_USER_AGENT;
export const OPENAI_AUTH_BASE = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface StoredCodexAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface CodexCredential {
  access: string;
  accountId?: string;
}

export interface RefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export class CodexRefreshError extends Error {
  constructor(reason: string, readonly status?: number) {
    super(`codex token refresh failed: ${reason}${status ? ` (status ${status})` : ''}`);
    this.name = 'CodexRefreshError';
  }
}

export function parseCodexAuth(value: string): StoredCodexAuth | null {
  try {
    const parsed = JSON.parse(value) as { openai?: StoredCodexAuth };
    return parsed.openai ?? null;
  } catch {
    return null;
  }
}

function jwtClaims(jwt: string): Record<string, any> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function accountIdFromJwt(jwt?: string): string | undefined {
  if (!jwt) return undefined;
  const claims = jwtClaims(jwt);
  if (!claims) return undefined;
  return (
    claims.chatgpt_account_id ??
    claims['https://api.openai.com/auth']?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

export function needsRefresh(stored: StoredCodexAuth, now: number): boolean {
  if (typeof stored.expires !== 'number') return false;
  return stored.expires - now < REFRESH_WINDOW_MS;
}

/**
 * Whether the current access token can still be used right now. Used as a grace
 * fallback: when a refresh blip (OpenAI auth briefly unreachable) happens, an
 * access token that hasn't actually expired yet should keep serving instead of
 * failing every Codex request.
 */
export function tokenStillValid(stored: StoredCodexAuth, now: number): boolean {
  if (!stored.access) return false;
  if (typeof stored.expires !== 'number') return true;
  return stored.expires > now;
}

export function applyRefresh(tokens: RefreshTokenResponse, current: StoredCodexAuth, now: number): StoredCodexAuth | null {
  if (!tokens.access_token) return null;
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? current.refresh,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    accountId: current.accountId ?? accountIdFromJwt(tokens.id_token),
  };
}

export function buildRefreshBody(refreshToken: string): string {
  return JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
}
