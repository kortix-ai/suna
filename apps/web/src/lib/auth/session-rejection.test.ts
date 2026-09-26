import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js';
import { describe, expect, test } from 'bun:test';

import { isDefinitiveSessionRejection } from './session-rejection';

// The real error classes supabase-js hands back from `getUser()`, not shapes
// invented here — `AuthRetryableFetchError` with status 0 is EXACTLY what an
// aborted fetch becomes (`@supabase/auth-js/dist/module/lib/fetch.js`,
// `handleError`: a non-Response throw -> `new AuthRetryableFetchError(msg, 0)`).

describe('isDefinitiveSessionRejection: only the auth server saying NO signs a session out', () => {
  test('401 from the auth server is definitive (JWT rejected / session gone)', () => {
    expect(isDefinitiveSessionRejection(new AuthApiError('invalid JWT', 401, 'bad_jwt'))).toBe(
      true,
    );
  });

  test('403 session_not_found is definitive (the row behind the JWT was deleted)', () => {
    expect(
      isDefinitiveSessionRejection(new AuthApiError('Session not found', 403, 'session_not_found')),
    ).toBe(true);
  });

  test('a missing session is definitive (nothing left to keep)', () => {
    expect(isDefinitiveSessionRejection(new AuthSessionMissingError())).toBe(true);
  });

  test('an aborted / failed fetch (status 0) is NOT definitive — the popup-close case', () => {
    // dev, 2026-09-17: the GitHub identity-proof popup closes itself 200ms
    // after posting its token; the in-flight `getUser()` aborts, and the
    // provider signed the WHOLE browser out over it.
    expect(isDefinitiveSessionRejection(new AuthRetryableFetchError('Failed to fetch', 0))).toBe(
      false,
    );
  });

  test('a 5xx from the auth server is NOT definitive — retryable outage, not a verdict', () => {
    expect(isDefinitiveSessionRejection(new AuthRetryableFetchError('Bad Gateway', 502))).toBe(
      false,
    );
    expect(isDefinitiveSessionRejection(new AuthApiError('Internal', 500, 'unexpected'))).toBe(
      false,
    );
  });

  test('429 rate limiting is NOT definitive', () => {
    expect(
      isDefinitiveSessionRejection(
        new AuthApiError('Too many requests', 429, 'over_request_rate_limit'),
      ),
    ).toBe(false);
  });

  test('an unknown error with no status is NOT definitive', () => {
    expect(isDefinitiveSessionRejection(new AuthUnknownError('boom', new Error('x')))).toBe(false);
    expect(isDefinitiveSessionRejection(new Error('plain'))).toBe(false);
    expect(isDefinitiveSessionRejection(null)).toBe(false);
  });
});
