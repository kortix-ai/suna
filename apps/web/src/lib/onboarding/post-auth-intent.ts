import {
  POST_AUTH_INTENT_COOKIE,
  POST_AUTH_INTENT_MAX_AGE,
} from '@/lib/onboarding/landing-destination';

/**
 * Browser-side access to the post-auth intent marker.
 *
 * A cookie and not sessionStorage because the server-side `/auth/callback`
 * route must be able to set it on its redirect response — magic-link and
 * OAuth signups never execute client code before landing on the door. The
 * value carries no identity and no token; it is a boolean with an expiry.
 */
export function markPostAuthIntent(): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${POST_AUTH_INTENT_COOKIE}=1` +
    `; Path=/; Max-Age=${POST_AUTH_INTENT_MAX_AGE}; SameSite=Lax${secure}`;
}

export function hasPostAuthIntent(): boolean {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return false;
  return document.cookie
    .split('; ')
    .some((entry) => entry === `${POST_AUTH_INTENT_COOKIE}=1`);
}
