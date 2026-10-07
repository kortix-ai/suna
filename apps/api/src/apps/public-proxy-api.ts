/**
 * `/_kortix/api/v1/*` on an App's own origin: the Kortix API, as the viewer.
 *
 * The API refuses an App origin's CORS preflight, and a per-App host list
 * cannot be configured. So a browser App calls this same-origin path instead.
 * The gate has already authorized the request (`authorizeAppRequest`). This
 * forwards it in-process to `/v1/*` with the viewer's App-scoped token
 * (`mintAppViewerToken`) as the bearer.
 *
 * - Only an App with `viewer_token_scope: 'api'` forwards. Its viewer's own
 *   IAM role stays the ceiling, exactly as for the token from `/_kortix/viewer`.
 * - The viewer is the one the gate's signed cookie names. The App's cookie,
 *   its own `Authorization` and the edge headers never reach the API.
 * - The cookie is `SameSite=None`, so a cross-site request is refused here
 *   (`Sec-Fetch-Site`, then `Origin` for a write) instead of acting as the
 *   viewer.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import { blockedPath, canonicalPath } from '../mcp/shape';
import { APP_EDGE_HEADERS } from '../shared/edge-signature';
import { APP_AUTHORIZATION_HEADER, resolveAppViewerUserId, type AppAccessRow } from './public-proxy-access';
import { APP_VIEWER_HEADER, APP_VIEWER_TOKEN_HEADER, mintAppViewerToken, normalizeViewerTokenScope } from './viewer';

export const APP_API_PROXY_PREFIX = '/_kortix/api';

const DROPPED_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'host',
  'origin',
  'referer',
  'x-forwarded-host',
  APP_AUTHORIZATION_HEADER,
  APP_VIEWER_HEADER,
  APP_VIEWER_TOKEN_HEADER,
  ...Object.values(APP_EDGE_HEADERS),
];

function refuse(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'cache-control': 'no-store' } });
}

function crossSite(request: Request, publicHost: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin';
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const origin = request.headers.get('origin');
  try {
    return !origin || new URL(origin).hostname.toLowerCase() !== publicHost;
  } catch {
    return true;
  }
}

export async function appApiProxyResponse(
  request: Request,
  url: URL,
  publicHost: string,
  app: AppAccessRow & { accountId: string; name: string; viewerTokenScope?: string | null },
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (normalizeViewerTokenScope(app.viewerTokenScope) !== 'api') {
    return refuse(403, 'viewer_api_disabled', "This App does not act as its viewer. Set its viewer_token_scope to 'api'.");
  }
  if (crossSite(request, publicHost)) {
    return refuse(403, 'cross_site_request', 'The App API path answers requests from the App’s own origin only.');
  }
  // Guard the path the router will see; forward the caller's spelling.
  const path = url.pathname.slice(APP_API_PROXY_PREFIX.length);
  const routed = canonicalPath(path);
  if (!path.startsWith('/v1/') || !routed?.startsWith('/v1/') || blockedPath(routed)) {
    return refuse(404, 'not_found', 'The App API path forwards /_kortix/api/v1/* only, except /v1/oauth and MCP.');
  }
  const userId = resolveAppViewerUserId(request, url, app);
  if (!userId) {
    return refuse(401, 'no_viewer_identity', 'No Kortix viewer is signed in to this App.');
  }
  const minted = await mintAppViewerToken(
    { appId: app.appId, accountId: app.accountId, name: app.name, viewerTokenScope: 'api' },
    userId,
  ).catch((error) => {
    logger.warn('[apps] API proxy token mint failed', { appId: app.appId, error: String(error) });
    return null;
  });
  if (!minted) return refuse(503, 'viewer_token_unavailable', 'The viewer token could not be issued. Retry.');

  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  headers.set('authorization', `Bearer ${minted.accessToken}`);
  // The API's own origin, never the App host: the dispatcher would route an
  // App host back here.
  const target = new URL(`${path}${url.search}`, new URL(config.KORTIX_URL || `http://localhost:${config.PORT}`).origin);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await forward(new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    signal: request.signal,
    duplex: 'half',
  } as RequestInit));
  // Nothing the API sets may land as a cookie on the App's origin.
  const out = new Headers(response.headers);
  out.delete('set-cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
