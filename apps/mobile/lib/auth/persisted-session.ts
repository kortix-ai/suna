import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

/**
 * Reads the session Supabase persisted to AsyncStorage without touching the
 * network. Used only when the normal restore does not settle in time: a
 * usable stored session means the user was signed in, so the app opens and
 * `onAuthStateChange` corrects the state once the token refresh lands.
 */
export function parsePersistedSession(raw: string | null): Session | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Session>;
  if (
    typeof candidate.access_token !== 'string' ||
    !candidate.access_token ||
    typeof candidate.refresh_token !== 'string' ||
    !candidate.refresh_token ||
    typeof candidate.user?.id !== 'string' ||
    !candidate.user.id
  ) {
    return null;
  }
  return candidate as Session;
}

/**
 * The session to show when a restore (`'RESTORE'`) or an auth event carries a
 * null session.
 *
 * auth-js returns null after a *retryable* refresh failure (offline, stalled
 * network) but keeps the refresh token in storage; the auto-refresh ticker
 * recovers later. A stored session therefore means the user is still signed
 * in. A non-retryable failure (revoked token) and every real sign-out remove
 * the stored session before the null result is emitted, so storage is empty
 * and the user is signed out. `SIGNED_OUT` always signs out.
 */
export function sessionForNullAuthResult(
  event: AuthChangeEvent | 'RESTORE',
  storedRaw: string | null
): Session | null {
  if (event === 'SIGNED_OUT') return null;
  return parsePersistedSession(storedRaw);
}
