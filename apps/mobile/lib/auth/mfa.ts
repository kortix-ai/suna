import type { Factor, Session, User } from '@supabase/supabase-js';

/**
 * TOTP step-up after sign-in. The rule is web's `mfaChallengeRequired`
 * (apps/web/src/lib/supabase/mfa.ts): a session below aal2 with a verified
 * TOTP factor completes the TOTP challenge before it reaches the app.
 *
 * The step-up also keeps the login: each TOTP verify on another device makes
 * GoTrue delete every aal1 session of the user, and an aal2 session stays.
 *
 * The check reads only the session (the token's `aal` claim and
 * `user.factors`), as auth-js `getAuthenticatorAssuranceLevel` does with a
 * stored session. It makes no network call, so an offline launch never waits
 * on it. A verified phone factor does not count: this screen cannot send an SMS.
 */
export function mfaChallengeRequired(session: Pick<Session, 'access_token' | 'user'> | null): boolean {
  if (!session || tokenAal(session.access_token) === 'aal2') return false;
  return !!verifiedTotpFactor(session.user);
}

/** The factor the step-up challenges, or undefined. */
export function verifiedTotpFactor(user: Pick<User, 'factors'>): Factor | undefined {
  return user.factors?.find((f) => f.status === 'verified' && f.factor_type === 'totp');
}

/** The token's `aal` claim, or null when the token does not decode. */
function tokenAal(accessToken: string): unknown {
  try {
    const part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).aal ?? null;
  } catch {
    return null;
  }
}

/**
 * Where `AuthProtection` and the auth layout send the user, or null to stay.
 * `segments` is `useSegments()`; the start screen (no segment) routes itself.
 */
export function authRedirect(input: {
  isAuthenticated: boolean;
  mfaRequired: boolean;
  segments: readonly string[];
}): '/' | '/auth' | '/auth/mfa' | null {
  const [first, second] = input.segments;
  if (first === undefined) return null;
  const onMfa = first === 'auth' && second === 'mfa';
  if (!input.isAuthenticated) return first === 'auth' && !onMfa ? null : '/auth';
  if (input.mfaRequired) return onMfa ? null : '/auth/mfa';
  return first === 'auth' ? '/' : null;
}
