import { APP_EDGE_HEADERS, edgeSecret as sharedEdgeSecret, edgeSignature, verifyEdgeSignedRequest } from '../edge/edge-signature';
import { resolveAppHost, type ResolvedAppHost } from './hostnames';
const EDGE_HOST_HEADER = APP_EDGE_HEADERS.host;

export interface ResolvedAppRequest extends ResolvedAppHost {
  publicHost: string;
}

/**
 * Direct-edge mode: no Cloudflare Apps Worker fronts this deployment, so the
 * operator's own reverse proxy is the trust boundary and requests arrive
 * unsigned. See verifyAppEdgeRequest.
 */
function appDirectEdgeMode(): boolean {
  return process.env.KORTIX_APPS_ALLOW_DIRECT_EDGE === 'true';
}

/**
 * The public hostname a request targets.
 *
 * `x-kortix-app-host` is an EDGE-SIGNED field: the Apps Worker sets it and the
 * HMAC verifyAppEdgeRequest checks covers it, which is what binds the header to
 * a real edge. It is therefore only trustworthy where that signature is also
 * verified.
 *
 * In direct-edge mode nothing verifies a signature, so trusting the header
 * would let ANY caller who can reach the public API origin name any App —
 * `x-kortix-app-host: <env>-<slug>-<route-key>.apps.<domain>` — and have the
 * API proxy them into it, past the App's own access policy. There, only the
 * real Host header decides which App (if any) a request is for.
 */
export function resolveAppRequest(request: Request, url: URL): ResolvedAppRequest | null {
  const claimedHost = appDirectEdgeMode() ? null : request.headers.get(EDGE_HOST_HEADER);
  const publicHost = (claimedHost || url.hostname).toLowerCase().replace(/\.$/, '');
  const matched = resolveAppHost(publicHost);
  return matched ? { ...matched, publicHost } : null;
}

function edgeSecret(): string {
  return sharedEdgeSecret(process.env.KORTIX_APPS_EDGE_SECRET);
}

export function appEdgeSignature(
  timestamp: string,
  host: string,
  method: string,
  pathAndQuery: string,
  secret = edgeSecret(),
): string {
  return edgeSignature(timestamp, host, method, pathAndQuery, secret);
}

export function verifyAppEdgeRequest(
  request: Request,
  url: URL,
  local: boolean,
  publicHost = url.hostname,
): boolean {
  if (local && (process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE !== 'false')) return true;
  // Unsigned by design — the operator's reverse proxy is the trust boundary.
  // resolveAppRequest refuses the caller-supplied host header in this mode, so
  // the App being served is the one the real Host header names.
  if (appDirectEdgeMode()) return true;
  return verifyEdgeSignedRequest(request, url, {
    headers: APP_EDGE_HEADERS,
    secret: edgeSecret(),
    publicHost,
  });
}
