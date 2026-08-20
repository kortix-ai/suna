/**
 * Session + user types, and the `exp` decoding that drives refresh.
 *
 * The session shape mirrors GoTrue's wire format (snake_case, `access_token` /
 * `refresh_token` / `expires_at`) on purpose: a host migrating off supabase-js
 * keeps every field access it already wrote, and the persisted blob is the same
 * object it reads back.
 */

import { base64UrlDecode } from './base64';
import { KortixAuthError } from './errors';

/** The authenticated user, as GoTrue reports it. */
export interface KortixAuthUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  aud?: string | null;
  created_at?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One signed-in session. `expires_at` is unix SECONDS, like GoTrue's. */
export interface KortixAuthSession {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. Always present — derived from `expires_in` when GoTrue omits it. */
  expires_at?: number;
  token_type: string;
  user: KortixAuthUser | null;
}

/** Default seconds before `exp` at which a token counts as expired. */
export const DEFAULT_EXPIRY_SKEW_SECONDS = 30;

/**
 * Decode a JWT's `exp` claim. Returns `null` when the token has no payload,
 * the payload is not decodable, or `exp` is absent/non-numeric — every case in
 * which the SDK must NOT conclude anything about expiry.
 */
export function decodeJwtExp(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(payload));
    if (!parsed || typeof parsed !== 'object') return null;
    const exp = (parsed as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Is `token` expired, or within `skewSeconds` of expiring?
 *
 * A token that cannot be parsed returns `false` — USE it and let the server be
 * the judge. Ported deliberately from `apps/web/src/lib/auth-token.ts:134-149`;
 * discarding a token we merely cannot read signs a working user out.
 */
export function isJwtExpired(
  token: string,
  skewSeconds: number = DEFAULT_EXPIRY_SKEW_SECONDS,
): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return false;
  return Date.now() / 1000 >= exp - skewSeconds;
}

/** GoTrue's token response, before normalization. */
export interface GoTrueSessionPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  user?: unknown;
}

/**
 * Normalize a GoTrue token response into a `KortixAuthSession`.
 *
 * `expires_at` is derived from `expires_in` when absent, so every persisted
 * session carries an absolute deadline: a relative `expires_in` read back from
 * storage after a reload would say "3600 seconds from now" forever.
 */
export function normalizeSession(payload: GoTrueSessionPayload): KortixAuthSession {
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new KortixAuthError('GoTrue response carried no access_token', {
      code: 'invalid_session_payload',
      body: payload,
    });
  }

  const expiresAt =
    typeof payload.expires_at === 'number'
      ? payload.expires_at
      : typeof payload.expires_in === 'number'
        ? Math.floor(Date.now() / 1000) + payload.expires_in
        : decodeJwtExp(accessToken) ?? undefined;

  return {
    access_token: accessToken,
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'bearer',
    user: isUser(payload.user) ? payload.user : null,
  };
}

function isUser(value: unknown): value is KortixAuthUser {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
