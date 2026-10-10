'use client';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';

/**
 * Client-side resume for a PKCE sign-in whose verifier cookie never reached
 * the `/auth/callback` exchange.
 *
 * The email-link flow mints its PKCE code verifier in the `sendEmailCode`
 * server action, which hands it to the browser as a cookie. The mailed link
 * detours through the mailbox and a redirect chain before the callback route
 * exchanges the code with that cookie on the server. When the cookie does not
 * survive that round trip (observed on prod: the FIRST magic-link flow in a
 * fresh browser profile lost it, every retry worked), the exchange throws
 * `pkce_code_verifier_not_found` and the visitor is bounced to /auth with a
 * false "expired" message while their link is still fresh.
 *
 * The verifier is not a secret from this browser — `@supabase/ssr` stores it
 * in a non-httpOnly cookie by design (the browser client must read it). So the
 * auth page snapshots it when the send succeeds and, when the callback bounces
 * the code back, re-seeds the cookie and navigates back to the callback, which
 * then runs the normal exchange and the normal server-side success path
 * (return-URL demotion, terms stamp, billing-aware landing) unchanged.
 */

const PKCE_VERIFIER_COOKIE = `${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`;
const BASE64_PREFIX = 'base64-';

/** sessionStorage survives the mail detour within one tab; cookies may not. */
const STASH_KEY = 'kortix:pkce-verifier';
/** One shot, keyed to the bounced code: a re-seeded exchange that still
 * bounces goes to the resend screen; a DIFFERENT code's bounce still resumes. */
const RESUME_GUARD_PREFIX = 'kortix:pkce-resume-armed:';

/**
 * The stash lives as long as the link it belongs to could still be opened:
 * GoTrue honors the emailed OTP for `mailer_otp_exp` (24 h on the production
 * project). A stale stash cannot pair with a different flow's code — the
 * exchange then fails once and the resume guard routes the visitor to the
 * resend screen.
 */
const STASH_TTL_MS = 24 * 60 * 60 * 1000;

export interface StashedVerifier {
  verifier: string;
  stashedAt: number;
}

function decodeVerifierCookieValue(raw: string): string | null {
  if (!raw.startsWith(BASE64_PREFIX)) return null;
  try {
    // base64url without padding — pad before atob so a verifier-length change
    // upstream degrades loudly, not by luck of a multiple-of-4 length.
    const b64 = raw.slice(BASE64_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the PKCE verifier cookie the server action just set. Returns null when
 * the cookie is absent, chunked (never true for a verifier), or unreadable.
 */
export function readBrowserPkceVerifier(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PKCE_VERIFIER_COOKIE) {
      return decodeVerifierCookieValue(rest.join('='));
    }
  }
  return null;
}

/** Snapshot the current verifier for a later same-tab resume. Idempotent per send. */
export function stashBrowserPkceVerifier(): void {
  if (typeof window === 'undefined') return;
  const verifier = readBrowserPkceVerifier();
  if (!verifier) return;
  try {
    window.sessionStorage.setItem(
      STASH_KEY,
      JSON.stringify({ verifier, stashedAt: Date.now() } satisfies StashedVerifier),
    );
  } catch {
    // Storage full or disabled: the cookie path remains the only resume source,
    // which is today's behavior.
  }
}

function loadStashedVerifier(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StashedVerifier;
    if (typeof parsed?.verifier !== 'string' || typeof parsed?.stashedAt !== 'number') return null;
    if (Date.now() - parsed.stashedAt > STASH_TTL_MS) {
      window.sessionStorage.removeItem(STASH_KEY);
      return null;
    }
    return parsed.verifier;
  } catch {
    return null;
  }
}

/**
 * Write the verifier cookie exactly the way the server action's ssr write does:
 * host-only, path=/, SameSite=Lax, `secure` on https — mirroring
 * `lib/supabase/client.ts`; a `Secure` cookie write is dropped on the http
 * local stack. The value must already carry the ssr encoding (`base64-` +
 * base64url of JSON) — both callers pass it through unchanged.
 */
function writePkceVerifierCookie(encoded: string): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${PKCE_VERIFIER_COOKIE}=${encoded}; path=/; SameSite=Lax${secure}`;
}

/**
 * Seed the verifier cookie from the sendEmailCode action's RESULT — the value
 * the action read back from the cookie it just wrote server-side.
 *
 * The action's own Set-Cookie does not always reach the browser: on the prod
 * edge deployment a successful send left the cookie jar empty (captured live:
 * the response carried no usable Set-Cookie), so the callback's exchange failed
 * `pkce_code_verifier_not_found` and every magic-link sign-in silently returned
 * to the form. The page now writes the cookie itself from the returned value —
 * the same pattern `signInWithPassword` already uses for the session tokens.
 * The verifier is not a secret from this browser (`@supabase/ssr` stores it
 * non-httpOnly by design), so carrying it in the action result adds no
 * exposure. Returns false when there is nothing to seed.
 */
export function seedBrowserPkceVerifier(encodedVerifier: string): boolean {
  if (typeof window === 'undefined' || !encodedVerifier) return false;
  try {
    writePkceVerifierCookie(encodedVerifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-seed the verifier cookie from the snapshot (or the cookie itself, when the
 * snapshot is gone but the cookie answered the read all along). Returns false
 * when there is nothing to seed — the caller then owes the visitor the resend
 * screen instead of a silent form.
 *
 * The seed must be a cookie write, not a storage call: `auth.storage` is
 * protected on the Supabase client, and the value has to satisfy the client's
 * cookie-backed read path (`@supabase/ssr` `base64-` + base64url + JSON), which
 * is exactly what the server action originally wrote.
 */
export function seedPkceVerifierForResume(): boolean {
  if (typeof window === 'undefined') return false;
  const verifier = loadStashedVerifier() ?? readBrowserPkceVerifier();
  if (!verifier) return false;
  try {
    const encoded = `${BASE64_PREFIX}${btoa(JSON.stringify(verifier))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
    writePkceVerifierCookie(encoded);
    return true;
  } catch {
    return false;
  }
}

/** Arm the one-shot guard before re-entering the callback with the seeded cookie. */
export function armPkceResumeGuard(authCode: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(RESUME_GUARD_PREFIX + authCode, '1');
  } catch {
    // Without the guard a failed re-entry could loop; the callback's own
    // bounce then runs one extra time and the visitor retries by hand.
  }
}

/** True when this exact code already bounced through a re-seeded exchange. */
export function consumePkceResumeGuard(authCode: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const key = RESUME_GUARD_PREFIX + authCode;
    const armed = window.sessionStorage.getItem(key) === '1';
    if (armed) window.sessionStorage.removeItem(key);
    return armed;
  } catch {
    return false;
  }
}
