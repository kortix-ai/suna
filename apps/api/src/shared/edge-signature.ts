/**
 * The trust boundary between a Cloudflare edge Worker and this API.
 *
 * Both hostname-routed surfaces — Kortix Apps (`*.apps.<domain>`) and sandbox
 * previews (`*.p.<domain>`) — are served by a Worker that forwards to the API's
 * own origin. That rewrite loses the public hostname: the upstream request
 * carries `Host: dev-api.kortix.com`, not the host the browser typed. The
 * Worker therefore re-states the public host in a header.
 *
 * A header anyone can set is not a routing decision anyone should be able to
 * make: without a signature, any caller reaching the API origin could name any
 * App or any preview and have the API proxy them into it. So the Worker signs
 * `timestamp \n host \n method \n path?query` and the API verifies before it
 * trusts the claimed host.
 *
 * Apps grew this first. Previews need exactly the same property, and a second
 * hand-rolled copy of an HMAC scheme is how two edges drift into accepting
 * different things — the same failure `preview-auth.ts` was written to end. One
 * implementation, parameterized by header set and secret.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

export interface EdgeHeaderNames {
  host: string;
  timestamp: string;
  signature: string;
}

export const APP_EDGE_HEADERS: EdgeHeaderNames = {
  host: 'x-kortix-app-host',
  timestamp: 'x-kortix-app-timestamp',
  signature: 'x-kortix-app-signature',
};

export const PREVIEW_EDGE_HEADERS: EdgeHeaderNames = {
  host: 'x-kortix-preview-host',
  timestamp: 'x-kortix-preview-timestamp',
  signature: 'x-kortix-preview-signature',
};

/** Replay window. The Worker and the API are both on NTP-disciplined clocks. */
export const EDGE_MAX_SKEW_MS = 5 * 60_000;

export function edgeSignature(
  timestamp: string,
  host: string,
  method: string,
  pathAndQuery: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${host.toLowerCase()}\n${method.toUpperCase()}\n${pathAndQuery}`)
    .digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when the request carries a live signature from the edge for exactly this
 * host, method and path. Every failure mode — missing header, host mismatch,
 * stale timestamp, bad MAC — returns false; callers answer 403.
 */
export function verifyEdgeSignedRequest(
  request: Request,
  url: URL,
  options: { headers: EdgeHeaderNames; secret: string; publicHost?: string },
): boolean {
  const { headers, secret } = options;
  const publicHost = options.publicHost ?? url.hostname;
  const host = request.headers.get(headers.host);
  const timestamp = request.headers.get(headers.timestamp);
  const signature = request.headers.get(headers.signature);
  if (!host || !timestamp || !signature) return false;
  if (host.toLowerCase() !== publicHost.toLowerCase()) return false;
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > EDGE_MAX_SKEW_MS) return false;
  return safeEqual(
    signature,
    edgeSignature(timestamp, host, request.method, `${url.pathname}${url.search}`, secret),
  );
}

/**
 * The secret shared with the edge Worker. `API_KEY_SECRET` is the fallback so a
 * deployment that never configured a dedicated edge secret still verifies
 * rather than silently accepting everything.
 */
export function edgeSecret(override?: string): string {
  return override || config.API_KEY_SECRET;
}
