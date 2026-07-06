'use client';

/**
 * Wrapper-mode's client-side token store — the counterpart to
 * `getApiKey`/`setApiKey`/`clearApiKey` in `src/lib/kortix.ts` for direct mode.
 * Holds the signed app session token `/api/auth/login` returns, fed to the SDK
 * via `getToken()` (see `configureWrapperMode`). The REAL credential is also
 * set as an HttpOnly cookie by the login route — this localStorage copy only
 * exists so the SDK's REST/SSE calls (which don't carry cookies) can attach
 * `Authorization: Bearer …`.
 */

const SESSION_KEY = 'lumen_session';

export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function setSessionToken(token: string): void {
  window.localStorage.setItem(SESSION_KEY, token.trim());
}

export function clearSessionToken(): void {
  window.localStorage.removeItem(SESSION_KEY);
}
