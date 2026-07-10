/**
 * SAML service-provider values for the deployment. Kortix delegates the SAML
 * SP role to the auth layer, so the two values every IdP (Entra, Okta, Google)
 * asks for when registering us are pure functions of the auth origin — the
 * same for every account, derivable before any provider is configured.
 *
 * Shared by the SSO card ("Service provider details" block) and the guided
 * SSO setup wizard. UI labels stay neutral ("Identifier (Entity ID)", "Reply
 * URL (ACS)") — the delegated provider is an internal detail.
 */

/**
 * Resolve the configured auth URL to an ABSOLUTE origin for display.
 *
 * `getEnv().SUPABASE_URL` may be root-relative (e.g. "/supabase") in the
 * sandbox preview, where the browser deliberately hits the same origin it was
 * served from. Mirrors `resolveBrowserSupabaseUrl` in `lib/supabase/client.ts`
 * (not exported there). Returns null when unresolvable (SSR with a relative
 * URL, malformed value) so callers hide the block instead of rendering a
 * broken URL.
 */
export function resolveSupabaseOrigin(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) {
    if (typeof window === 'undefined') return null;
    try {
      return new URL(url, window.location.origin).toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return url.replace(/\/$/, '');
}

export interface SamlSpUrls {
  /** Identifier (Entity ID) — the SP metadata URL the IdP fetches. */
  entityId: string;
  /** Reply URL (Assertion Consumer Service) — where the IdP posts assertions. */
  acsUrl: string;
}

export function buildSamlSpUrls(supabaseUrl: string | undefined): SamlSpUrls | null {
  const origin = resolveSupabaseOrigin(supabaseUrl);
  if (!origin) return null;
  return {
    entityId: `${origin}/auth/v1/sso/saml/metadata`,
    acsUrl: `${origin}/auth/v1/sso/saml/acs`,
  };
}
