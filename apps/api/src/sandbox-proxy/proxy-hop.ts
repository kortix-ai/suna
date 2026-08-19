/**
 * WHICH hop failed — the fact every "sandbox unreachable" response used to omit.
 *
 * A request through this proxy crosses four of them, and they fail for reasons
 * that have nothing in common:
 *
 *   - `control_plane`   — us. The `session_sandboxes` row is not `active`, so we
 *                         answered without ever dialling the box. An answer, not
 *                         silence.
 *   - `provider_ingress`— the sandbox provider's edge. We could not resolve or
 *                         reach an address for this box at all.
 *   - `daemon`          — the in-box agent / opencode. The box answers, the
 *                         runtime does not.
 *   - `upstream_port`   — the user's OWN process on an ordinary app port. Their
 *                         dev server is down; the runtime is fine.
 *
 * Collapsing all four into a bare 502 is what let the web app read a dev server
 * that was never started as "the sandbox is gone" and paint "Waking this session
 * up…" over a live session. The SDK probe now increments its failure counter
 * only for `provider_ingress` and `daemon` — see
 * `packages/sdk/src/react/use-runtime-reconnect.ts`.
 */

import { carriesSessionData } from './session-data-ports';

export type ProxyHop = 'control_plane' | 'provider_ingress' | 'daemon' | 'upstream_port';

/**
 * Response headers carrying the attribution. The body carries the same values,
 * but a browser probe reads the header without parsing (and without a body at
 * all on a HEAD or an HTML error page), so the header is the primary channel.
 * Both must be CORS-exposed — the web app and the API are different origins.
 */
export const PROXY_HOP_HEADER = 'X-Kortix-Proxy-Hop';
export const PROXY_UPSTREAM_STATUS_HEADER = 'X-Kortix-Upstream-Status';

/**
 * Which hop owns a failure on this EFFECTIVE upstream port, once the provider
 * edge has answered.
 *
 * The discriminator is the port, because that is exactly what separates "the
 * runtime did not answer" from "your app did not answer": the session's
 * conversation lives on the daemon/opencode ports and nothing else does. Take
 * the effective port (Platinum rewrites 4096 → 8000), not the client-addressed
 * one, so the same box classifies identically on both providers.
 */
export function portFailureHop(upstreamPort: number): ProxyHop {
  return carriesSessionData(upstreamPort) ? 'daemon' : 'upstream_port';
}
