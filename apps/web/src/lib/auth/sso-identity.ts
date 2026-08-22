/**
 * The SSO identity-mismatch notice.
 *
 * An identity provider does not have to return the identity the user asked for.
 * If the browser already holds an IdP session for someone else, the IdP can
 * answer our SAML request with THAT person — a valid assertion for an identity
 * the user never typed. Supabase exchanges it, the callback signs the browser
 * in as that account, and nothing on screen says so. Observed live: an admin
 * registered their own domain on a test provider, signed in, and came back
 * authenticated as a different person with no indication anything unusual had
 * happened. See docs/ENTRA_SSO_SCIM_SETUP.md.
 *
 * The fix is to remember what the user typed BEFORE the IdP hop and compare it
 * to who came back. This module is that comparison and nothing else.
 *
 * Two properties hold deliberately:
 *
 *  - **Nothing here authorizes anything.** The cookie is a display hint. No
 *    session, route, or permission decision reads it. Deleting it, forging it,
 *    or replaying it changes only whether a notice is drawn — never who the
 *    user is signed in as. That is why a plain client-set cookie is enough.
 *  - **It fails open, never loud.** A missing or unreadable value yields "no
 *    mismatch". A notice that cries wolf on every ordinary login is a notice
 *    people learn to click through, which would cost more than it buys.
 */

/** Short-lived, set client-side immediately before navigating to the IdP. */
export const SSO_EXPECTED_EMAIL_COOKIE = 'kortix_sso_expected_email';

/**
 * Fifteen minutes. Long enough for a slow IdP hop — a password page, an MFA
 * push, a device-compliance check — and short enough that an abandoned attempt
 * cannot still be sitting there to mislabel an unrelated sign-in an hour later.
 * The callback also clears it unconditionally, so this bound only covers the
 * case where the user never comes back at all.
 */
export const SSO_EXPECTED_EMAIL_MAX_AGE = 60 * 15;

/**
 * Marks the post-auth redirect. Carries no address on purpose: the signed-in
 * email would otherwise sit in the URL bar, in browser history, and in the
 * Referer of anything the landing page requests. The notice reads the address
 * from the session it already has instead.
 */
export const SSO_IDENTITY_PARAM = 'sso_identity';
export const SSO_IDENTITY_MISMATCH = 'mismatch';

/** Longer than any address worth comparing; a guard against a junk cookie. */
const MAX_EMAIL_LENGTH = 320;

export function normalizeAuthEmail(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return '';
  return trimmed.toLowerCase();
}

/**
 * True only when both addresses are present AND differ.
 *
 * Absence is not evidence: a password login, a magic link, or a cleared cookie
 * all arrive with nothing to compare, and none of them is a mismatch.
 */
export function isSsoIdentityMismatch(
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  const typed = normalizeAuthEmail(expected);
  const returned = normalizeAuthEmail(actual);
  if (!typed || !returned) return false;
  return typed !== returned;
}

/** Decode a cookie value written by `rememberSsoExpectedEmail`. */
export function readSsoExpectedEmail(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw) return '';
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // A malformed value is treated as absent, not as a mismatch.
    return '';
  }
  return normalizeAuthEmail(value);
}

/**
 * Remember the typed address just before `window.location` leaves for the IdP.
 *
 * Client-side by necessity — the navigation to the IdP is client-initiated, so
 * there is no response of ours to attach a Set-Cookie to. `SameSite=Lax` is
 * what makes it survive the IdP's top-level GET redirect back to /auth/callback.
 */
export function rememberSsoExpectedEmail(email: string | null | undefined): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeAuthEmail(email);
  if (!normalized) return;
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${SSO_EXPECTED_EMAIL_COOKIE}=${encodeURIComponent(normalized)}` +
    `; Max-Age=${SSO_EXPECTED_EMAIL_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}
