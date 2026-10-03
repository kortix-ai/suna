/**
 * The personal TOTP gate: a session signed in with the first factor only
 * (aal1) whose account has a verified authenticator-app factor owes the
 * 6-digit challenge before it may use the app. The magic link or password
 * proves the mailbox, not the factor.
 *
 * One module, three contexts:
 *
 * - the sign-in completions (auth callback route, the password server
 *   actions) detect the factor and hand the session its `returnUrl`-shaped
 *   challenge redirect — and set `MFA_PENDING_COOKIE`;
 * - the middleware reads that cookie together with the JWT's `aal` claim to
 *   hold every app path behind the challenge while it is pending (closing
 *   the typed-URL / bookmark path);
 * - the challenge page clears the cookie after a successful verification,
 *   and also when no verified factor exists any more (a stale flag from a
 *   removed factor must never trap a session).
 *
 * The cookie is a UX gate, not the security boundary: the server-side
 * assertion an API can re-check is the token's `aal` claim, and the
 * account-wide "Require MFA" flag is the IAM-level enforcement that exists.
 */

export const MFA_PENDING_COOKIE = 'kortix-mfa-pending';

/** Outlives a dropped tab so the gate survives a later direct navigation. */
export const MFA_PENDING_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface FactorLike {
  id?: string;
  factor_type?: string;
  status?: string;
}

/** The account's verified authenticator-app (TOTP) factor, if one is
 *  enrolled. GoTrue's token/user responses only carry verified factors, so
 *  the status filter is belt and braces — an unverified enrollment never
 *  gates. Phone factors are a separate enrollment path and never gate.
 *  Generic so the caller keeps its own factor shape (e.g. `FactorInfo`). */
export function pickVerifiedTotpFactor<T extends FactorLike>(
  factors: T[] | null | undefined,
): T | null {
  return (
    factors?.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified') ?? null
  );
}

/** Whether this signed-in user has a verified authenticator-app (TOTP)
 *  factor — the predicate every TOTP gate keys on. */
export function hasVerifiedTotpFactor(
  user: { factors?: FactorLike[] | null } | null | undefined,
): boolean {
  return pickVerifiedTotpFactor(user?.factors) !== null;
}

/** The redirect a sign-in with a pending factor takes: the challenge, with
 *  the resolved destination riding along for after the code verifies. */
export function mfaChallengePath(returnUrl: string): string {
  return `/auth/mfa?returnUrl=${encodeURIComponent(returnUrl)}`;
}

export function mfaPendingCookieOptions() {
  return {
    maxAge: MFA_PENDING_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  };
}

/** Whether the middleware holds this request at the challenge.
 *
 *  All three inputs must agree: a session whose token has not verified its
 *  second factor (`aal` ≠ 'aal2'), a pending cookie (set by the sign-in
 *  completions, cleared by the challenge) that says the account HAS a factor
 *  to verify — without it every factor-less account (whose token is aal1
 *  too) would be held forever — and a route the gate owns: app paths and
 *  `/`, never the public marketing pages, which anonymous visitors see
 *  anyway. Pure so the gate is testable without a Supabase session.
 */
export function middlewareOwesTotpChallenge({
  aal,
  pendingCookie,
  isPublicRoute,
  pathname,
}: {
  aal: string | undefined;
  pendingCookie: string | undefined;
  isPublicRoute: boolean;
  pathname: string;
}): boolean {
  return !!aal && aal !== 'aal2' && pendingCookie === '1' && (!isPublicRoute || pathname === '/');
}

/** The challenge clears its own flag from the browser (the cookie is
 *  intentionally not httpOnly — the client completes the challenge). */
export function clearMfaPendingCookieClient(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${MFA_PENDING_COOKIE}=; Max-Age=0; path=/`;
}
