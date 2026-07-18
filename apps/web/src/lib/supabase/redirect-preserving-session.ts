import { NextResponse } from 'next/server';

/**
 * Minimal shape of `NextResponse.cookies` needed to copy staged mutations.
 * Deliberately has no index signature: `ResponseCookies.getAll()` returns
 * objects with more fields (path, maxAge, httpOnly, …), and TS only allows
 * that wider shape to satisfy this narrower one when this interface doesn't
 * itself declare an index signature.
 */
export interface CookieJar {
  getAll(): Array<{ name: string; value: string }>;
}

/**
 * Build a redirect response that preserves cookie mutations already staged on
 * `sourceCookies` — a transparently-refreshed session, or a self-heal
 * cookie-clear — instead of the caller having to remember to copy them by
 * hand on every redirect site.
 *
 * `NextResponse.redirect()` always constructs a brand-new `Response`. Any
 * `Set-Cookie` mutations made earlier in middleware (e.g. on a shared
 * `supabaseResponse`) are silently dropped unless copied onto that new
 * response explicitly. Without this, a redirect issued right after the
 * Supabase client runs can bounce the browser to a new URL while it still
 * carries the exact stale/invalid cookie that caused the redirect in the
 * first place — the classic "self-heal that never reaches the browser" bug.
 */
export function redirectPreservingCookies(url: URL, sourceCookies: CookieJar): NextResponse {
  const response = NextResponse.redirect(url);
  for (const cookie of sourceCookies.getAll()) {
    response.cookies.set(cookie as never);
  }
  return response;
}
