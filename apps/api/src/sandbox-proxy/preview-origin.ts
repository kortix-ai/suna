/**
 * Preview ORIGIN proxy — `{env}-p{port}-{label}.{previewDomain}` in a deployed
 * environment, `p{port}-{label}.localhost:{apiPort}` locally.
 *
 * Serving a sandbox port on its own origin is what makes an arbitrary app work
 * unmodified: it sees itself at `/`, so root-absolute links, `fetch('/api')`,
 * `history.pushState`, CSS `url(/x.png)`, service workers and WebSockets all
 * resolve to the same origin the browser is already on. The path form
 * (`/v1/p/{sandbox}/{port}/…`) cannot offer that and stays what it has always
 * been — the transport for programmatic clients. See preview-hosts.ts.
 *
 * Shape of a request:
 *   1. `resolvePreviewRequest` reads the (label, port) target out of the
 *      hostname the browser used. Bun.serve dispatches here before Hono, which
 *      cannot route on a Host header.
 *   2. Auth comes from the signed cookie (preview-session.ts) when present, and
 *      otherwise from a one-shot `?token=` / `?public_share=` that mints one.
 *      A browser can attach neither a header nor a query parameter to
 *      `fetch('/api')` from inside the app, so a cookie is the only credential
 *      that survives to the second request — including the WebSocket handshake.
 *   3. `forwardToSandbox` does the rest: ownership, service-key auth, signed
 *      X-Kortix-User-Context, auto-wake retries.
 */

import { authenticatePreviewPrincipalDetailed, extractPreviewToken } from './preview-auth';
import { forwardToSandbox } from './routes/preview';
import { resolveExternalIdFromHostLabel } from './backend';
import { config } from '../config';
import { PREVIEW_STATE_HEADER, previewStatePage, type PreviewState } from './preview-state-page';
import {
  isAllowedPreviewOrigin,
  previewCorsHeaders as corsHeaders,
  resolvePreviewHost,
  type ResolvedPreviewHost,
} from './preview-hosts';
import {
  PREVIEW_EDGE_HEADERS,
  edgeSecret,
  verifyEdgeSignedRequest,
} from '../shared/edge-signature';
import {
  PREVIEW_SESSION_TTL_SECONDS,
  PREVIEW_SHARE_TTL_SECONDS,
  mintPreviewSession,
  previewSessionCookies,
  readPreviewCookies,
  verifyPreviewSession,
  type PreviewSession,
} from './preview-session';
import {
  PUBLIC_SHARE_BLOCKED_PORTS,
  PUBLIC_SHARE_VIEW_METHODS,
  STATIC_FILE_SHARE_PORT,
  isViewOnlyShare,
  publicShareToken as publicShareTokenFor,
  resolvePublicShare,
  touchPublicShare,
} from '../shared/session-public-shares';

export { resolvePreviewHost };

export interface ResolvedPreviewRequest {
  target: ResolvedPreviewHost;
  /** The hostname the BROWSER used — what the app must believe it is served on. */
  publicHost: string;
  /** False when a preview host is claimed without a valid edge signature. */
  verified: boolean;
}

/**
 * Direct-edge mode: no Cloudflare preview Worker fronts this deployment, so the
 * operator's own reverse proxy is the trust boundary and requests arrive
 * unsigned with the real Host intact.
 */
function previewDirectEdgeMode(): boolean {
  return process.env.KORTIX_PREVIEW_ALLOW_DIRECT_EDGE === 'true';
}

/**
 * Which preview (if any) a request targets.
 *
 * The edge Worker forwards to the API's own origin, so the upstream `Host` is
 * `dev-api.kortix.com` and the browser's hostname survives only in the SIGNED
 * `x-kortix-preview-host` header. Trusting that header unsigned would let any
 * caller reaching the API origin name any preview — and would put sandbox
 * content back on the API origin, which is the whole thing this design removes.
 * So a claimed host counts only when the signature over it verifies.
 */
export function resolvePreviewRequest(req: Request, url: URL): ResolvedPreviewRequest | null {
  const claimedHost = previewDirectEdgeMode() ? null : req.headers.get(PREVIEW_EDGE_HEADERS.host);
  const publicHost = (claimedHost || req.headers.get('host') || url.hostname || '').toLowerCase();
  const target = resolvePreviewHost(publicHost);
  if (!target) return null;

  // A local `*.localhost` preview never passes through an edge, and a
  // direct-edge deployment signs nothing by design.
  const verified =
    target.local
    || previewDirectEdgeMode()
    || verifyEdgeSignedRequest(req, url, {
      headers: PREVIEW_EDGE_HEADERS,
      secret: edgeSecret(process.env.KORTIX_PREVIEW_EDGE_SECRET),
      publicHost,
    });

  // Keep the port. `resolvePreviewHost` strips it for MATCHING, but this value
  // is the address the browser is actually on: it becomes X-Forwarded-Prefix
  // (the base every relative asset resolves against) and the return URL on the
  // sign-in page. Dropping `:8008` sends both to the wrong port in local dev.
  return { target, publicHost, verified };
}

/**
 * True when this request addresses a preview origin. The Bun.serve dispatcher
 * asks before it does anything else, because Hono cannot route on a hostname.
 */
export function isPreviewHost(req: Request, url: URL): boolean {
  return resolvePreviewRequest(req, url) !== null;
}

/** Query parameters that carry a one-shot credential, never forwarded upstream. */
const CREDENTIAL_PARAMS = ['token', 'public_share'] as const;

function jsonError(status: number, message: string, origin: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/**
 * The refusal a caller should get. A person navigating to a preview origin gets
 * a page they can act on (see preview-gate-page.ts); a script gets the JSON it
 * can parse. Deciding by `Sec-Fetch-Dest` rather than by status keeps
 * `fetch('/api')` inside the app from ever receiving HTML.
 */
function gateResponse(
  req: Request,
  url: URL,
  input: { status: 401 | 403 | 404; state: PreviewState; message: string; origin: string; publicHost: string },
): Response {
  if (!isDocumentNavigation(req)) {
    return jsonError(input.status, input.message, input.origin);
  }
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const returnTo = `${proto}://${input.publicHost}${url.pathname}${url.search}`;
  return new Response(
    previewStatePage({
      state: input.state,
      returnTo,
      frontendUrl: config.FRONTEND_URL || '',
    }),
    {
      // 401/403/404 keep their real status: every intermediary passes those
      // through, and a monitor should see them. Only the TRANSIENT states
      // (see preview-state-page.ts) answer 200, because a 5xx gets replaced.
      status: input.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        [PREVIEW_STATE_HEADER]: input.state,
        ...corsHeaders(input.origin),
      },
    },
  );
}

/**
 * Resolve a public-share token into a grant for THIS preview, or null. The
 * share must name this exact sandbox and port — a share for one port is not a
 * key to the box.
 */
async function authenticatePublicShare(
  token: string | null,
  sandboxId: string,
  port: number,
): Promise<{ shareId: string; mode: string; filePath: string | null } | null> {
  if (!token) return null;
  const resolved = await resolvePublicShare(token);
  if (!resolved.ok) return null;

  const share = resolved.row;
  if (share.externalId !== sandboxId) return null;

  // A share names ONE thing. A preview share names a port; a file share names a
  // single file served by the static-web port. Accepting a file share for any
  // other port — or for any path other than its own file — would turn a link to
  // one document into a key to the whole box.
  if (share.resourceType === 'preview') {
    // The blocked set exists to stop a PREVIEW share naming an infrastructure
    // port (ssh, the daemon, opencode, static-web).
    if (share.port !== port || PUBLIC_SHARE_BLOCKED_PORTS.has(port)) return null;
  } else if (share.resourceType === 'file') {
    // A file share targets the static-web port BY DESIGN — that is the port
    // that serves it — so the blocked set does not apply here. What keeps it
    // safe is the pinning below: the request is rewritten to this share's own
    // file, so reaching 3211 grants that one document and nothing else.
    if (port !== STATIC_FILE_SHARE_PORT || !share.filePath) return null;
  } else {
    return null;
  }

  void touchPublicShare(share.shareId).catch(() => {});
  return {
    shareId: share.shareId,
    mode: share.mode,
    filePath: share.resourceType === 'file' ? (share.filePath as string) : null,
  };
}

/**
 * The session a request already carries, verified against the host it arrived
 * on. Both cookie copies are tried (see preview-session.ts on why there are two).
 */
export function sessionFromCookies(req: Request, target: ResolvedPreviewHost): PreviewSession | null {
  for (const value of readPreviewCookies(req.headers.get('Cookie'))) {
    const session = verifyPreviewSession(value, target);
    if (session) return session;
  }
  return null;
}

/** Why a preview could not be served, before it is rendered for anyone. */
export interface PreviewRefusal {
  status: 401 | 404;
  state: PreviewState;
  message: string;
}

/**
 * Authenticate a request that has no cookie yet, using the one-shot credential
 * in the URL (or an Authorization header, for non-browser callers).
 *
 * Returns the minted session, or a REFUSAL rather than a Response: the same
 * refusal has to become a page for a browser and a status for a WebSocket
 * handshake, and only the caller knows which it is.
 */
export async function establishPreviewSession(
  req: Request,
  url: URL,
  target: ResolvedPreviewHost,
): Promise<{ session: PreviewSession } | { refusal: PreviewRefusal }> {
  const shareToken = url.searchParams.get('public_share');
  const previewToken = extractPreviewToken(req, url);
  if (!shareToken && !previewToken) {
    // Answer before touching the database. Resolving a host LABEL cannot use
    // the external_id index (see resolveExternalIdFromHostLabel), so letting an
    // anonymous caller reach it would let anyone spend a table scan per made-up
    // hostname. Nothing here is authorized without a credential anyway.
    return { refusal: { status: 401, state: 'signed-out', message: 'Unauthorized' } };
  }

  const sandboxId = await resolveExternalIdFromHostLabel(target.sandboxLabel);
  if (!sandboxId) {
    // No sandbox has ever carried this label. Say "not found", not
    // "unauthorized": there is nothing here to be authorized for, and a 401
    // would send the web app into a pointless re-auth loop.
    return { refusal: { status: 404, state: 'unknown', message: 'Unknown preview' } };
  }

  const share = await authenticatePublicShare(shareToken, sandboxId, target.port);
  if (share) {
    return {
      session: {
        kind: 'public_share',
        sandboxLabel: target.sandboxLabel,
        sandboxId,
        port: target.port,
        shareId: share.shareId,
        mode: share.mode,
        filePath: share.filePath,
        exp: 0,
      },
    };
  }

  const principal = await authenticatePreviewPrincipalDetailed(previewToken, sandboxId);
  if (!principal?.userId) {
    return { refusal: { status: 401, state: 'signed-out', message: 'Unauthorized' } };
  }

  return {
    session: {
      kind: 'principal',
      sandboxLabel: target.sandboxLabel,
      sandboxId,
      port: target.port,
      userId: principal.userId,
      // A non-null sessionId here means the credential is BOUND to a session —
      // i.e. it is the sandbox's own token (see PreviewPrincipal). Every other
      // branch returns null, and dropping it would let a sandbox-authored
      // request extend its own deadline.
      callerSessionId: principal.sessionId,
      sandboxAuthored: principal.sessionId !== null,
      exp: 0,
    },
  };
}

/** Set-Cookie values that persist a freshly established session. */
export function cookiesForSession(session: PreviewSession, secure: boolean): string[] {
  const ttl = session.kind === 'public_share' ? PREVIEW_SHARE_TTL_SECONDS : PREVIEW_SESSION_TTL_SECONDS;
  const { exp: _exp, ...payload } = session;
  return previewSessionCookies(mintPreviewSession(payload, ttl), { secure, maxAgeSeconds: ttl });
}

/**
 * True when this request may carry the ambient preview cookie into a write.
 *
 * `Sec-Fetch-Site` is the browser's own answer and is unforgeable from script;
 * `same-origin` and `none` (a typed URL or a bookmark) are ours. Where it is
 * absent — a non-browser client, an old browser — fall back to `Origin`, and
 * allow a request that carries no Origin at all, which is what curl and the CLI
 * send. Reads are never gated: the danger is a state change, and a cross-origin
 * READ is already governed by the CORS allowlist.
 */
function isSameSiteRequest(req: Request, publicHost: string): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === publicHost || isAllowedPreviewOrigin(origin);
  } catch {
    return false;
  }
}

/** True when the request is a top-level navigation (not a subresource/XHR). */
function isDocumentNavigation(req: Request): boolean {
  const dest = req.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  return (req.headers.get('accept') || '').includes('text/html');
}

/**
 * Handle a preview-origin request end-to-end. Returns null when the Host header
 * is not a preview, so the caller falls through to normal API routing.
 */
export async function handlePreviewOriginRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const resolved = resolvePreviewRequest(req, url);
  if (!resolved) return null;
  const { target, publicHost } = resolved;

  const origin = req.headers.get('Origin') || '';
  if (!resolved.verified) {
    // A preview hostname was claimed without the edge signature that binds it.
    // Refuse rather than fall through: falling through would serve API routing
    // under a hostname the caller chose.
    return gateResponse(req, url, {
      status: 403,
      state: 'forbidden',
      message: 'Unsigned preview host',
      origin,
      publicHost,
    });
  }

  // CORS preflight must succeed BEFORE auth — browsers send OPTIONS without
  // credentials, and rejecting the preflight blocks the real request from ever
  // carrying the ones that would authenticate it.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  // `SameSite=None` requires `Secure`, and without it the cookie is not sent to
  // an embedded preview at all. Plain-http `*.localhost` still qualifies:
  // browsers treat localhost as a trustworthy origin and accept Secure cookies
  // there, which is what keeps the local iframe preview working.
  const secure = proto === 'https' || target.local;

  let session = sessionFromCookies(req, target);
  let setCookies: string[] = [];

  if (!session) {
    const established = await establishPreviewSession(req, url, target);
    if ('refusal' in established) {
      return gateResponse(req, url, { ...established.refusal, origin, publicHost });
    }
    session = established.session;
    setCookies = cookiesForSession(session, secure);
  }

  // Get the credential out of the URL on ANY navigation that still carries one,
  // not just the one that minted the cookie. The client appends `?token=` on
  // every render, so an iframe that remounts re-lands the JWT in
  // `location.search` — where same-origin code written by the agent can read
  // it, and where it reaches history and same-origin Referers. Bouncing once to
  // the clean URL is cheap and idempotent.
  const carriedInUrl = CREDENTIAL_PARAMS.some((p) => url.searchParams.has(p));
  if (carriedInUrl && isDocumentNavigation(req) && (req.method === 'GET' || req.method === 'HEAD')) {
    const clean = new URL(url);
    for (const p of CREDENTIAL_PARAMS) clean.searchParams.delete(p);
    const headers = new Headers({
      Location: `${clean.pathname}${clean.search}${clean.hash}`,
      ...corsHeaders(origin),
    });
    for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
  }

  // A cross-site WRITE must not ride the ambient cookie.
  //
  // `SameSite=None` is what lets the session panel embed a preview, and it also
  // means a form auto-submitted from evil.com arrives with the cookie attached.
  // The app's own CSRF defence cannot help: the proxy deliberately rewrites
  // `Origin` to the upstream so frameworks see a consistent pair (see
  // routes/preview.ts), so the check has to live here.
  if (!isSameSiteRequest(req, publicHost)) {
    return jsonError(403, 'Cross-site request to a preview', origin);
  }

  if (session.kind === 'public_share') {
    // A view-only share stays view-only on this edge too. The path form has
    // refused writes since the SSR-PV1 pentest finding; the origin form now
    // serves the same links, so without this the gate simply moved aside.
    if (isViewOnlyShare({ mode: session.mode, filePath: session.filePath }) &&
        !PUBLIC_SHARE_VIEW_METHODS.has(req.method.toUpperCase())) {
      return jsonError(405, 'This public share is view-only', origin);
    }

    // Revocation has to be live. The signed cookie carries its own expiry, so
    // without re-reading the row a revoked or expired link keeps working for
    // the rest of the cookie's life — the path form re-checks on every request
    // and this must not be the weaker door.
    const still = await resolvePublicShare(publicShareTokenFor(session.shareId));
    if (!still.ok) return jsonError(410, 'This share is no longer available', origin);
  }

  // Body (read once, before the retries inside forwardToSandbox).
  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer();
  }

  // Strip the one-shot credentials so the sandbox app never sees them.
  const forwardSearchParams = new URLSearchParams(url.search);
  for (const p of CREDENTIAL_PARAMS) forwardSearchParams.delete(p);
  const forwardSearch = forwardSearchParams.toString();
  let queryString = forwardSearch ? `?${forwardSearch}` : '';

  // A FILE share is a link to one document, not to the static-web port. Pin the
  // request to that file whatever the visitor asks for, exactly as the path
  // form's forwardFileShare does.
  let forwardPath = url.pathname;
  if (session.kind === 'public_share' && session.filePath) {
    forwardPath = '/open';
    queryString = `?path=${encodeURIComponent(session.filePath)}`;
  }

  // Public origin the browser used — the hostname it typed, not the API host
  // the edge forwarded to. Prefer X-Forwarded-Proto (set by the TLS-terminating
  // edge) and fall back to the scheme Bun actually saw; never hardcode https,
  // or the injected static-web <base> tag points at https against an http
  // listener and every relative asset fails.
  const publicOrigin = `${proto}://${publicHost}`;

  try {
    const response = await forwardToSandbox(
      session.sandboxId,
      target.port,
      session.kind === 'principal'
        ? {
            kind: 'principal',
            userId: session.userId,
            callerSessionId: session.callerSessionId,
            // `callerSessionId` here is only ever the SANDBOX's own token
            // binding — a Supabase login never reaches it — so it is also the
            // correct agent binding for the manager-override gate.
            boundCredentialSessionId: session.callerSessionId,
            sandboxAuthored: session.sandboxAuthored,
          }
        : { kind: 'public_share' },
      req.method,
      forwardPath,
      queryString,
      req.headers,
      body,
      // Same-origin requests need no CORS headers at all, and injecting them
      // would overwrite whatever the app itself sends. Only a genuinely
      // cross-origin caller gets the allow-origin echo.
      origin && origin.toLowerCase() === publicOrigin.toLowerCase() ? '' : origin,
      // A preview origin serves at the host root, so redirects stay
      // root-relative (no /v1/p/<sandbox>/<port> prefix to re-apply).
      '',
      // …and X-Forwarded-Prefix is just the origin — relative assets resolve to
      // this same host, which routes straight back here.
      publicOrigin,
      { originMode: true },
    );

    if (setCookies.length === 0) return response;
    const headers = new Headers(response.headers);
    for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    console.error(
      `[preview-origin] ${target.sandboxLabel}:${target.port}${url.pathname}:`,
      err instanceof Error ? err.message : err,
    );
    return jsonError(502, 'Failed to proxy to sandbox', origin);
  }
}
