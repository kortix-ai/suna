/**
 * Subdomain preview proxy — `p{port}-{sandboxId}.localhost:{apiPort}/...`
 *
 * Carried over from main, trimmed to what this branch actually needs:
 *   - Parse the `Host` header at the Bun.serve level (before Hono routing
 *     kicks in) to recognize preview subdomains.
 *   - First-request auth: validate a Bearer JWT / Kortix token / `?token=`
 *     query param, then mark the subdomain "authenticated" in-memory for
 *     a TTL. All subsequent requests on the subdomain are trusted — this
 *     side-steps third-party cookie restrictions inside iframes and lets
 *     sub-resources, redirects, WS upgrades flow through unchanged.
 *   - HTTP forwarding goes through `forwardToSandbox` so we reuse the same
 *     path resolution (Daytona's getPreviewLink(port)) that the path-based
 *     `/v1/p/:sandboxId/:port` route uses.
 *
 * What this DOESN'T cover (yet): WebSocket upgrade on the subdomain. The
 * agent server's `/proxy/{port}/*` handler is HTTP-only, and the API's WS
 * fan-out was removed earlier in this refactor. WS plumbing is a follow-up.
 */

import { authenticatePreviewPrincipal, extractPreviewToken } from './preview-auth';
import { forwardToSandbox } from './routes/preview';

// ── Subdomain parsing ───────────────────────────────────────────────────────

const SUBDOMAIN_REGEX = /^p(\d+)-([^.]+)\.localhost/;

export function parsePreviewSubdomain(host: string): { port: number; sandboxId: string } | null {
  const match = host.match(SUBDOMAIN_REGEX);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { port, sandboxId: match[2] };
}

// ── First-request auth state ────────────────────────────────────────────────
//
// Once a subdomain is authenticated, all subsequent requests on it pass
// through without further auth. We remember the validated userId so that
// downstream `forwardToSandbox` can sign X-Kortix-User-Context with the right
// identity (the agent-server's auth gate verifies that header).

interface AuthState {
  userId: string;
  expiresAt: number;
}

// In-memory subdomain auth gate (see authenticatePreviewPrincipal / markAuthedSubdomain).
const authedSubdomains = new Map<string, AuthState>();
const AUTH_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function key(sandboxId: string, port: number): string {
  return `p${port}-${sandboxId}`;
}

function getAuthedSubdomain(sandboxId: string, port: number): AuthState | null {
  const entry = authedSubdomains.get(key(sandboxId, port));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authedSubdomains.delete(key(sandboxId, port));
    return null;
  }
  return entry;
}

function markAuthedSubdomain(sandboxId: string, port: number, userId: string): void {
  authedSubdomains.set(key(sandboxId, port), {
    userId,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  });
}

// Periodic cleanup of expired entries — keeps the map from growing
// unboundedly under churn.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authedSubdomains) {
    if (now > v.expiresAt) authedSubdomains.delete(k);
  }
}, 30 * 60 * 1000);

// Token validation + extraction live in ./preview-auth, shared with the
// WebSocket edge so every entry point accepts the same credentials.

// ── Request handler ─────────────────────────────────────────────────────────

/**
 * Handle a subdomain preview request end-to-end. Returns:
 *   - `Response` to send back to the client
 *   - `null` to indicate "not a subdomain request — let the caller fall through"
 */
export async function handleSubdomainRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const host = req.headers.get('host') || '';
  const subdomain = parsePreviewSubdomain(host);
  if (!subdomain) return null;

  const { port, sandboxId } = subdomain;
  const origin = req.headers.get('Origin') || '';

  // CORS preflight must succeed BEFORE auth — browsers send OPTIONS without
  // Authorization headers, and rejecting the preflight blocks the real
  // request from ever carrying the Bearer token that would authenticate us.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  let authed = getAuthedSubdomain(sandboxId, port);

  // Not authed yet — try to validate from token in headers or query.
  if (!authed) {
    const token = extractPreviewToken(req, url);
    const validatedUserId = await authenticatePreviewPrincipal(token, sandboxId);
    if (!validatedUserId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Credentials': 'true',
          },
        },
      );
    }
    markAuthedSubdomain(sandboxId, port, validatedUserId);
    authed = { userId: validatedUserId, expiresAt: Date.now() + AUTH_SESSION_TTL_MS };
  }

  // Body (read once, before retries inside forwardToSandbox).
  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer();
  }

  // Strip the one-shot `?token` (used only to authenticate the first request)
  // so the sandbox app never sees it. Everything else passes through.
  const forwardSearchParams = new URLSearchParams(url.search);
  forwardSearchParams.delete('token');
  const forwardSearch = forwardSearchParams.toString();
  const queryString = forwardSearch ? `?${forwardSearch}` : '';

  // Public origin the browser used to reach this subdomain. Prefer the proxy's
  // X-Forwarded-Proto (set by a TLS-terminating LB in prod) and fall back to the
  // scheme Bun actually saw (http in local dev) — never hardcode https, or the
  // injected static-web <base> tag points at https against an http listener and
  // every relative asset fails with ERR_SSL_PROTOCOL_ERROR.
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const publicOrigin = `${proto}://${host}`;

  // Hand off to the shared forwarder. It handles ownership, service-key auth,
  // X-Kortix-User-Context signing, auto-wake retries, etc.
  //
  // remainingPath is the FULL pathname here — the subdomain itself encodes
  // the (sandboxId, port) target, so the rest of the URL is what the
  // proxied app expects to see.
  try {
    return await forwardToSandbox(
      sandboxId,
      port,
      authed.userId,
      req.method,
      url.pathname,
      queryString,
      req.headers,
      body,
      origin,
      // Subdomain previews serve at the host root, so redirects stay
      // root-relative (no /v1/p/<sandbox>/<port> prefix).
      '',
      // …and X-Forwarded-Prefix is just the origin — relative assets resolve to
      // p{port}-{sandbox}.host/abs/... which routes straight back here.
      publicOrigin,
    );
  } catch (err) {
    console.error(
      `[subdomain-proxy] ${sandboxId}:${port}${url.pathname}:`,
      err instanceof Error ? err.message : err,
    );
    return new Response(
      JSON.stringify({ error: 'Failed to proxy to sandbox' }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        },
      },
    );
  }
}
