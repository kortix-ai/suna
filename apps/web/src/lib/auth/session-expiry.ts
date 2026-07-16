export interface SessionExpiryLike {
  expires_at?: number | null;
}

/**
 * True when a Supabase session's own `expires_at` claim (unix seconds) is
 * already in the past.
 *
 * Used on the auth page to stop trusting a cached `user`/`session` object the
 * moment we can prove it's dead, rather than waiting for the ambient
 * background-refresh timer (or some unrelated API call) to notice and
 * self-correct. That correction can take seconds in production — during that
 * window a component that blindly trusts `user` truthiness renders a
 * "signed in, redirecting" placeholder with no form, spinner, or escape
 * hatch, which is exactly what stranded users on a blank /auth page.
 */
export function isSessionExpired(session: SessionExpiryLike | null | undefined): boolean {
  return (
    !!session && typeof session.expires_at === 'number' && Date.now() / 1000 >= session.expires_at
  );
}
