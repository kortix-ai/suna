/**
 * Only a definitive GoTrue rejection may end the login.
 *
 * auth-js removes the stored session and emits `SIGNED_OUT` when a token
 * refresh fails with a non-retryable error and the access token has expired.
 * It treats every non-ok answer it cannot classify as non-retryable: a JSON
 * 429 or 408, or a 4xx from a proxy, captive portal or WAF. After an hour in
 * the background the access token has always expired, so one such answer
 * signed the user out.
 *
 * The guard lets an ok answer and a definitive rejection through. For any
 * other non-ok refresh answer it throws, so auth-js raises
 * `AuthRetryableFetchError`, keeps the stored session and retries later.
 * No React Native imports: `bun test` covers this file.
 */

import { requestUrl, type FetchFunction } from '@/lib/utils/with-deadline';

/** GoTrue error codes that prove the refresh token or its user is gone. */
export const DEFINITIVE_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'user_not_found',
  'user_banned',
]);

/**
 * A 400, 401 or 403 whose JSON body names a code from the set. GoTrue sends
 * the code as `code` (API version 2024-01-01 and later) or `error_code`, the
 * two fields auth-js reads.
 */
export function isDefinitiveRefreshRejection(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  if (typeof body !== 'object' || body === null) return false;
  const { code, error_code } = body as { code?: unknown; error_code?: unknown };
  return [code, error_code].some((c) => typeof c === 'string' && DEFINITIVE_REFRESH_ERROR_CODES.has(c));
}

function isRefreshRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = requestUrl(input);
  return init?.method === 'POST' && url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token');
}

/** Wraps the auth client's fetch. Every request except a token refresh passes through unchanged. */
export function createRefreshGuardFetch(fetchImpl: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok || !isRefreshRequest(input, init)) return response;
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // Not JSON: a proxy or portal answered, not GoTrue.
    }
    if (isDefinitiveRefreshRejection(response.status, body)) return response;
    throw new TypeError(`Token refresh answered HTTP ${response.status}`);
  };
}
