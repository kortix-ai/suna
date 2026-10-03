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
 * auth page snapshots it when the send succeeds and, if the callback bounces
 * back with the code, re-seeds the cookie and completes the exchange HERE, in
 * the same tab that started the flow. The session then lands in the same
 * cookies the app already reads.
 */

const PKCE_VERIFIER_COOKIE = `${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`;
const BASE64_PREFIX = 'base64-';

/** sessionStorage survives the mail detour within one tab; cookies may not. */
const STASH_KEY = 'kortix:pkce-verifier';
/** A verifier older than its link could ever be is not worth seeding. */
const STASH_TTL_MS = 15 * 60 * 1000;

export interface PkceResumeClient {
  auth: {
    exchangeCodeForSession(authCode: string): Promise<{
      data: { session?: unknown; user?: unknown };
      error: { message?: string } | null;
    }>;
  };
}

interface StashedVerifier {
  verifier: string;
  stashedAt: number;
}

function decodeVerifierCookieValue(raw: string): string | null {
  if (!raw.startsWith(BASE64_PREFIX)) return null;
  try {
    const json = atob(raw.slice(BASE64_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
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

export function clearStashedPkceVerifier(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STASH_KEY);
  } catch {
    // Nothing to clean up.
  }
}

/**
 * The verifier, to seed back into the cookie jar: the stashed one, else the
 * one still in the cookie (the callback may have bounced for a reason the
 * cookie itself can still answer).
 */
function verifierForResume(): string | null {
  return loadStashedVerifier() ?? readBrowserPkceVerifier();
}

/**
 * Re-seed the verifier cookie and complete the exchange in this browser.
 *
 * The seed must be a cookie write, not a storage call: `auth.storage` is
 * protected on the Supabase client, and the client's cookie-backed read path
 * (`@supabase/ssr`) is exactly what a `base64-…` cookie satisfies. Returns the
 * exchange result untouched so the caller decides what a failure means.
 */
export async function resumePkceExchange(
  authCode: string,
  client: PkceResumeClient,
): Promise<{ resumed: boolean; message?: string }> {
  const verifier = verifierForResume();
  if (!verifier || !authCode) return { resumed: false };
  try {
    const encoded = `${BASE64_PREFIX}${btoa(JSON.stringify(verifier))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
    // Host-only cookie, same path/scope the client writes its cookies with;
    // `secure` only on https, mirroring `lib/supabase/client.ts` — a `Secure`
    // cookie write is dropped on the http local stack.
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${PKCE_VERIFIER_COOKIE}=${encoded}; path=/; SameSite=Lax${secure}`;
    const { data, error } = await client.auth.exchangeCodeForSession(authCode);
    if (error || !data?.session) {
      return { resumed: false, message: error?.message ?? 'missing session' };
    }
    clearStashedPkceVerifier();
    return { resumed: true };
  } catch (error) {
    return { resumed: false, message: error instanceof Error ? error.message : 'unexpected' };
  }
}
