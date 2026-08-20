/**
 * Preview-proxy auth helpers (pure).
 *
 * A host hook drives the cookie/token exchange against the preview proxy; these
 * helpers decide the auth endpoint and the token-append rule so the proxy auth
 * scheme lives in exactly one place. They target the current proxy surface:
 * path-based `/v1/p/{sandbox}/{port}/…`, the daemon `/proxy/{port}/…`, and the
 * subdomain `p{port}-{sandbox}.{host}/…` form.
 */

function derivePreviewAuthEndpoint(candidateUrl: string): string | null {
  try {
    const url = new URL(candidateUrl);

    if (/^\/proxy\/\d+(?:\/|$)/.test(url.pathname)) {
      return `${url.origin}/v1/p/auth`;
    }

    const previewIndex = url.pathname.indexOf('/p/');
    if (previewIndex !== -1) {
      return `${url.origin}${url.pathname.slice(0, previewIndex)}/p/auth`;
    }

    return `${url.origin}/v1/p/auth`;
  } catch {
    return null;
  }
}

function isPreviewProxyUrl(candidateUrl: string, serverUrl?: string): boolean {
  try {
    const url = new URL(candidateUrl);
    const path = url.pathname;
    const isPreviewPath =
      /^\/v1\/p\/[^/]+\/\d+(?:\/|$)/.test(path) ||
      /^\/proxy\/\d+(?:\/|$)/.test(path);
    if (!isPreviewPath) return false;

    const trustedOrigins = new Set<string>();
    if (serverUrl) {
      try {
        trustedOrigins.add(new URL(serverUrl).origin);
      } catch {}
    }
    if (typeof window !== 'undefined') {
      trustedOrigins.add(window.location.origin);
    }
    return trustedOrigins.size === 0 || trustedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

/**
 * Resolve the `POST /…/p/auth` endpoint that sets the `__preview_session`
 * cookie for a given preview URL. Returns null when the URL isn't a trusted
 * preview-proxy URL.
 */
export function buildPreviewAuthEndpoint(
  previewUrl: string,
  serverUrl?: string,
): string | null {
  if (!isPreviewProxyUrl(previewUrl, serverUrl)) return null;
  return (
    (serverUrl ? derivePreviewAuthEndpoint(serverUrl) : null) ??
    derivePreviewAuthEndpoint(previewUrl)
  );
}

/**
 * Preview ORIGIN form: `p{port}-{sandbox}.{host}` locally, or the deployed
 * `{env}-p{port}-{sandbox}.{domain}`.
 *
 * These can't use the host-only `/v1/p/` session cookie — it never reaches
 * another hostname — so they authenticate the FIRST request with a one-shot
 * `?token`, which the proxy exchanges for a cookie on the preview origin and
 * then strips. Every later request (sub-resources, `fetch`, WebSockets) rides
 * that cookie, which is the only credential an app's own code can carry.
 */
export function isSubdomainPreviewUrl(candidateUrl: string): boolean {
  try {
    const { hostname } = new URL(candidateUrl);
    return (
      /^p\d+-[^.]+\./.test(hostname)
      || /^(?:dev|staging|prod|preview)-p\d+-[a-z0-9-]+\./i.test(hostname)
    );
  } catch {
    return false;
  }
}

/** Append a one-shot `?token` to a (subdomain) preview URL. */
export function appendPreviewToken(previewUrl: string, token: string): string {
  try {
    const u = new URL(previewUrl);
    u.searchParams.set('token', token);
    return u.toString();
  } catch {
    return previewUrl;
  }
}
