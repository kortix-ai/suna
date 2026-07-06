/**
 * Wrapper-mode direct-preview helpers.
 *
 * `session.previewUrl()` always builds its URL from the SDK's configured
 * `backendUrl` — in wrapper mode that's this app's own `/api/kortix` proxy, so
 * the result looks like `${origin}/api/kortix/p/{sandboxId}/{port}{path}`
 * (the SDK's path-based proxy form; see `packages/sdk/src/session/url.ts`).
 * We parse that shape locally — rather than reaching into an SDK-internal
 * module for `parseSubdomainUrl` — to pull out `{sandboxId, port, path}`, then
 * rebuild a DIRECT upstream preview URL using a short-lived, project-scoped
 * token from `/api/preview-token`. Going direct-to-upstream (instead of
 * through our own proxy) is required because a Next.js route handler can't
 * proxy a WebSocket upgrade — see `src/app/api/preview-token/route.ts`.
 */

const PROXY_PATH_RE = /\/p\/([^/]+)\/(\d+)(\/.*)?$/;

export interface ParsedProxyPreview {
  sandboxId: string;
  port: number;
  path: string;
}

/** Extract `{sandboxId, port, path}` from a proxied preview URL, or `null` if it isn't one. */
export function parseProxiedPreviewUrl(proxiedUrl: string): ParsedProxyPreview | null {
  try {
    const { pathname, search, hash } = new URL(proxiedUrl);
    const match = pathname.match(PROXY_PATH_RE);
    if (!match) return null;
    return { sandboxId: match[1], port: Number(match[2]), path: `${match[3] || '/'}${search}${hash}` };
  } catch {
    return null;
  }
}

/** Build a direct (non-proxied) upstream preview URL authenticated with a scoped token. */
export function buildDirectPreviewUrl(
  upstreamBase: string,
  parsed: ParsedProxyPreview,
  token: string,
): string {
  const base = upstreamBase.replace(/\/+$/, '');
  const path = parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`;
  const url = new URL(`${base}/p/${parsed.sandboxId}/${parsed.port}${path}`);
  url.searchParams.set('token', token);
  return url.toString();
}
