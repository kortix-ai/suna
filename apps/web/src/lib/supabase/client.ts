import { getEnv } from '@/lib/env-config';
import { createBrowserClient } from '@supabase/ssr';
import { KORTIX_SUPABASE_AUTH_COOKIE } from './constants';
import { authCookieOptions, isInExtensionPanel, writePanelMarker } from './panel-cookies';

/**
 * Resolve the browser-facing Supabase URL as an ABSOLUTE URL.
 *
 * `getEnv().SUPABASE_URL` may be root-relative (e.g. "/supabase") in the sandbox
 * preview, where the browser deliberately hits the same origin it was served
 * from and the preview proxy (next.config.ts: /supabase/* -> in-sandbox
 * Supabase) forwards the request. supabase-js requires an ABSOLUTE URL, so
 * resolve the relative value against the current origin.
 */
function resolveBrowserSupabaseUrl(url: string): string {
  if (url.startsWith('/') && typeof window !== 'undefined') {
    return new URL(url, window.location.origin).toString().replace(/\/$/, '');
  }
  return url;
}

/**
 * Whether this Supabase instance has SAML/SSO enabled. Used to gate the
 * work-email SSO probe on the auth screen: a fresh self-hosted deployment has it
 * off, so probing would only surface a `saml_provider_disabled` 404. Fails closed
 * (returns false) on any error so SSO stays opt-in.
 */
export async function fetchSamlEnabled(): Promise<boolean> {
  try {
    const runtimeEnv = getEnv();
    const url = resolveBrowserSupabaseUrl(runtimeEnv.SUPABASE_URL);
    const key = runtimeEnv.SUPABASE_ANON_KEY;
    if (!url || !key) return false;
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    if (!res.ok) return false;
    const data = (await res.json()) as { saml_enabled?: boolean };
    return Boolean(data?.saml_enabled);
  } catch {
    return false;
  }
}

export function createClient() {
  const runtimeEnv = getEnv();
  const url = resolveBrowserSupabaseUrl(runtimeEnv.SUPABASE_URL);
  const key = runtimeEnv.SUPABASE_ANON_KEY;

  // `@supabase/ssr` never sets `secure` itself (confirmed against the
  // installed package's `dist/` — zero matches for `secure`), so on
  // production HTTPS the session cookie was written without it: readable over
  // a plaintext downgrade or a same-network MITM. Mirrors
  // `last-project-cookie.ts`'s `window.location.protocol === 'https:'` check
  // — NOT `httpOnly`, which `createBrowserClient` needs JS read access to
  // avoid (see the class doc on `@supabase/ssr`).
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';

  // Inside the Kortix in Chrome side panel the session lives in a partitioned
  // cookie (see panel-cookies.ts), and the marker tells the server so.
  const panel = isInExtensionPanel();
  if (panel) writePanelMarker();
  const cookieOptions = { name: KORTIX_SUPABASE_AUTH_COOKIE, ...authCookieOptions(panel, secure) };

  if (!url || !key) {
    if (typeof window !== 'undefined') {
      throw new Error('Missing Supabase browser environment variables');
    }

    return createBrowserClient('https://placeholder.invalid', 'placeholder-anon-key', {
      cookieOptions,
    });
  }

  return createBrowserClient(url, key, {
    cookieOptions,
  });
}
