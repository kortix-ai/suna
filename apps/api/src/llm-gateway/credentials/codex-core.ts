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
  /** The provider's error code, when it sent one. */
  readonly code?: string;
  /** Only signing in again fixes it (`isPermanentRefreshRejection`). */
  readonly permanent: boolean;

  constructor(reason: string, readonly status?: number, details: { code?: string; permanent?: boolean } = {}) {
    super(`codex token refresh failed: ${reason}${status ? ` (status ${status})` : ''}`);
    this.name = 'CodexRefreshError';
    this.code = details.code;
    this.permanent = details.permanent ?? false;
  }
}

/**
 * Codes that mean the refresh token itself is dead. OpenAI answers an unknown
 * or revoked token with 401 `invalid_refresh_token` (measured 2026-09-25);
 * Codex CLI also names `refresh_token_expired`, `refresh_token_reused` and
 * `refresh_token_invalidated`; RFC 6749 servers answer 400 `invalid_grant`.
 */
const DEAD_REFRESH_TOKEN_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

/** The code of a rejected refresh: `{ error: { code } }` (OpenAI) or `{ error: '<code>' }` (RFC 6749). */
export function refreshErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Whether a rejected refresh can only be fixed by signing in again. A 401 is:
 * the provider no longer accepts the login. A 400 or 403 is only with a
 * dead-token code; without one it is our malformed request. Rate limits,
 * timeouts and server errors are transient.
 */
export function isPermanentRefreshRejection(status: number, code: string | undefined): boolean {
  if (status === 401) return true;
  if (status === 400 || status === 403) return code !== undefined && DEAD_REFRESH_TOKEN_CODES.has(code);
  return false;
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
