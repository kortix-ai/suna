import { config } from '../../lib/config';
import { KORTIX_SERVICE_CALL_HEADER } from '../sessions/kortix-user-context';
import { previewCorsHeaders } from './preview-hosts';
import { PREVIEW_STATE_HEADER, type PreviewState, previewStatePage } from './preview-state-page';
import { PROXY_HOP_HEADER, PROXY_UPSTREAM_STATUS_HEADER, type ProxyHop } from './proxy-hop';

// Hop-by-hop + caller-controlled headers we never forward upstream. Auth is
// replaced with the sandbox service key, trace headers are regenerated, and
// Accept-Encoding is forced to identity (raw byte passthrough) EXCEPT on the
// paths named by `forwardsClientEncoding` below.
// Cookies may contain the caller's raw __preview_session credential and must
// never reach arbitrary user-controlled apps running inside the sandbox.
// `x-kortix-service-call` marks a DIRECT platform→daemon call. The daemon gates
// its destructive branch reset on it precisely because it cannot appear here:
// we authenticate every forwarded request with the sandbox's own service key, so
// the daemon cannot tell a user's request from ours by the bearer alone. Strip
// it for the same reason we strip `authorization` — a caller must not be able to
// hand themselves platform authority by naming a header.
export const STRIP_FORWARD_HEADERS = new Set([
  'x-kortix-wire-id-placed',
  'host',
  'authorization',
  'cookie',
  'traceparent',
  'x-request-id',
  'accept-encoding',
  'content-length',
  KORTIX_SERVICE_CALL_HEADER.toLowerCase(),
]);

// Remove the `frame-ancestors` directive from a CSP value, preserving the rest.
// Returns null if nothing meaningful remains (so the header can be dropped).
export function stripFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length ? kept.join('; ') : null;
}

// Build the response headers we send back to the browser: clone the upstream
// headers, neutralize framing restrictions, and apply CORS. Previews are
// embedded in the Kortix session UI via an <iframe>, so any app that ships
// `X-Frame-Options` or a CSP `frame-ancestors` (Next.js, and most frameworks,
// default to these) would otherwise refuse to load in the panel. Stripping them
// at the proxy makes embedding work for ANY project without per-app config —
// the same project-agnostic approach as the origin/host re-origination above.
// Framing is intentionally OPEN, and that is not the same as unprotected. The
// credential is now an ambient `SameSite=None` cookie, so any site can frame a
// signed-in user's live preview — what stops that being useful is the
// cross-site gate in preview-origin.ts (reads are governed by the CORS
// allowlist, writes and WebSocket upgrades require a same-site Sec-Fetch-Site),
// not a framing restriction.
export function clientResponseHeaders(upstreamHeaders: Headers, origin: string): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete('x-frame-options');
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    const csp = headers.get(key);
    if (csp && /frame-ancestors/i.test(csp)) {
      const next = stripFrameAncestors(csp);
      if (next) headers.set(key, next);
      else headers.delete(key);
    }
  }
  // One allowlist for both edges — see previewCorsHeaders. An arbitrary origin
  // gets nothing, because the preview cookie is ambient on cross-site requests.
  for (const [key, value] of Object.entries(previewCorsHeaders(origin))) {
    headers.set(key, value);
  }

  // The app inside the sandbox writes its own cookies, and they are forwarded —
  // that is what makes a cookie-session app work. What it may NOT do is widen
  // their scope: `p.kortix.com` is not on the Public Suffix List, so a
  // `Domain=kortix.com` cookie from a preview would be accepted for the web app
  // and the API too. Strip `Domain` (leaving a host-only cookie, which is what
  // the app actually needs) and drop any attempt to overwrite ours.
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    headers.delete('set-cookie');
    for (const cookie of setCookies) {
      const name = cookie.split('=', 1)[0]?.trim();
      if (name === '__kortix_preview' || name === '__kortix_preview_chips') continue;
      headers.append(
        'set-cookie',
        cookie
          .split(';')
          .filter((attr) => !/^\s*domain\s*=/i.test(attr))
          .join(';'),
      );
    }
  }
  return headers;
}

// Is this request a top-level browser navigation (so it expects an HTML page,
// not JSON)? Used to decide whether an "unreachable" state renders a friendly
// page or a machine-readable error. `Accept: text/html` is the standard signal;
// `sec-fetch-dest` covers document/iframe loads that send a terse Accept.
export function isBrowserNavigation(incomingHeaders: Headers): boolean {
  const accept = incomingHeaders.get('accept') || '';
  if (accept.includes('text/html')) return true;
  const dest = incomingHeaders.get('sec-fetch-dest') || '';
  return dest === 'document' || dest === 'iframe' || dest === 'frame';
}

/**
 * The address the browser is on, reconstructed from the request it sent. Shown
 * on the state page and carried into the sign-in hand-off. Falls back to '' when
 * the headers do not say, which simply omits it from the page.
 */
function previewReturnTo(incomingHeaders: Headers): string {
  const forwarded = incomingHeaders.get('x-kortix-preview-host') || incomingHeaders.get('x-forwarded-host');
  const host = forwarded || incomingHeaders.get('host') || '';
  if (!host) return '';
  const proto = incomingHeaders.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

// Response for an unreachable / not-yet-ready sandbox port: a friendly HTML page
// for browser navigations, machine-readable JSON otherwise. Marked no-store so a
// retry always re-hits the upstream instead of a cached error.
//
// `hop` is mandatory: the status alone cannot distinguish a parked row from a
// dead runtime from a dev server the agent never started, and a caller that has
// to guess guesses wrong (see `proxy-hop.ts`). `upstreamStatus` is the status
// the failing hop actually returned, when there was one — a thrown/refused
// connection has none.
export function portUnreachableResponse(opts: {
  port: number;
  status: number;
  origin: string;
  incomingHeaders: Headers;
  reason: string;
  hop: ProxyHop;
  upstreamStatus?: number | null;
  // Stable machine code for the failure class (e.g. 'sandbox_not_ready'), so
  // clients branch on a code instead of matching the human-readable `reason`.
  code?: string;
  // True when the failure is transient by design (a parked/booting box) and a
  // retry of the same request is expected to succeed once the box is up.
  retry?: boolean;
}): Response {
  const { port, status, origin, incomingHeaders, reason, hop, code, retry } = opts;
  const upstreamStatus = opts.upstreamStatus ?? null;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  // Set on EVERY variant, HTML included: a `fetch` probe that lands on the
  // browser-navigation branch (it sends `Accept: text/html`) must still be able
  // to attribute the failure.
  headers.set(PROXY_HOP_HEADER, hop);
  if (upstreamStatus !== null) {
    headers.set(PROXY_UPSTREAM_STATUS_HEADER, String(upstreamStatus));
  }
  // The SAME allowlist as every other preview response — this was a third copy
  // of the policy and it still echoed any origin back with credentials.
  const cors = previewCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  if (Object.keys(cors).length) {
    // Without this the browser hides both headers from JS and the probe is back
    // to guessing — the web app and the API are always different origins.
    headers.set(
      'Access-Control-Expose-Headers',
      `${PROXY_HOP_HEADER}, ${PROXY_UPSTREAM_STATUS_HEADER}`,
    );
  }
  if (isBrowserNavigation(incomingHeaders)) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    // A browser gets 200 and a page it can read, NOT the 5xx.
    //
    // "The dev server has not bound the port yet" and "the box is still waking"
    // are the ordinary first seconds of a preview, not gateway failures — and
    // reporting them as 5xx meant this page never arrived: Cloudflare replaces
    // an origin 5xx with its own branded error interstitial (proved by the
    // absence of x-kortix-proxy-hop on what reached the client). The real state
    // stays fully legible — the status is still on every non-navigation
    // response, and both hop headers are set here too, so a fetch probe reads
    // exactly what it always did.
    const state: PreviewState =
      code === 'sandbox_not_ready' || retry === true ? 'starting'
      : upstreamStatus === null ? 'not-listening'
      : 'unreachable';
    headers.set(PREVIEW_STATE_HEADER, state);
    return new Response(
      previewStatePage({
        state,
        port,
        returnTo: previewReturnTo(incomingHeaders),
        frontendUrl: config.FRONTEND_URL || '',
      }),
      { status: 200, headers },
    );
  }
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({
      error: reason,
      port,
      status,
      hop,
      upstream_status: upstreamStatus,
      ...(code ? { code } : {}),
      ...(retry !== undefined ? { retry } : {}),
    }),
    {
      status,
      headers,
    },
  );
}

// Response for a blocking session-turn (`POST /session/:id/message`) that
// outran the proxy's retry budget while the upstream was still actively
// computing — i.e. NOT the "sandbox is unreachable/dead" case portUnreachableResponse
// describes. Conflating the two is actively misleading: it makes a healthy,
// still-working sandbox look down, and it invites a naive caller to retry the
// exact same (non-idempotent — it would resubmit the user's message) request
// against a connection shape that can never fit it. 504 + a distinct machine
// code let a caller branch on "this call structurally cannot block for that
// long over this connection" and switch to `prompt_async` + the `/global/event`
// SSE stream instead (what the web UI already does). No-store: a retry should
// always re-evaluate the upstream, never replay a cached verdict.
export function longTurnTimeoutResponse(origin: string): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(
    JSON.stringify({
      error:
        'Turn is still running and outran this connection’s budget. Blocking POST /session/:id/message ' +
        'cannot wait out a long reasoning/tool turn (the ALB idle-times a stalled connection); use ' +
        'prompt_async and consume /global/event (SSE) instead of blocking on this endpoint.',
      code: 'LONG_TURN_PROXY_TIMEOUT',
    }),
    { status: 504, headers },
  );
}

// Rewrite an upstream redirect Location so the user stays on the preview.
// `redirectPrefix` is the URL prefix that maps to this sandbox port:
//   - subdomain previews (p{port}-{sandbox}.host):  '' (root-relative)
//   - path-based previews (/v1/p/{sandbox}/{port}):  '/v1/p/{sandbox}/{port}'
// App self-redirects (relative, or absolute to the upstream's own origin) are
// kept on the preview. Genuinely external redirects (OAuth, CDNs, …) pass
// through unchanged so the browser can follow them — we never hard-block, since
// blocking turned ordinary app redirects into 502s.
export function sanitizeRedirectLocation(
  previewUrl: string,
  location: string | null,
  redirectPrefix: string,
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) {
    return `${redirectPrefix}${location}`;
  }
  try {
    const target = new URL(location, previewUrl);
    const preview = new URL(previewUrl);
    const selfHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname);
    if (target.origin === preview.origin || selfHost) {
      return `${redirectPrefix}${target.pathname}${target.search}${target.hash}`;
    }
    return location;
  } catch {
    return null;
  }
}

// True only when a fetch failure PROVES nothing reached the box: the upstream
// actively refused the connection (nothing was ever accepted). Any other thrown
// error — timeout, abort, connection reset mid-flight — is ambiguous: the
// sandbox may already have received and accepted the prompt, so a re-send would
// duplicate it. Used to gate the one safe prompt-delivery retry in the catch.
export function isConnectionRefusedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
  };
  const codes = [e.code, e.cause?.code].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => c === 'ECONNREFUSED')) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /econnrefused|connection refused|failed to connect|unable to connect/i.test(message);
}
