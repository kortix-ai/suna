// Whether the post-request `Request completed:` line for a sandbox-proxy
// request is suppressed entirely as expected proxy noise — a designed answer,
// not a server failure. Lives beside the proxy it classifies: the suppression
// keys on the attribution headers this layer sets (forward/retry.ts) and asks
// this layer's runtime-verb classifier (runtime-request.ts).

import { classifyRuntimeRequest } from './runtime-request';

/**
 * Whether the post-request `Request completed:` line is suppressed entirely as
 * expected sandbox-proxy noise — a designed answer, not a server failure.
 *
 * The Better Stack log sweep counts every line whose `status` is `>= 500` as a
 * 5xx of the route on the line, so a designed 5xx-shaped answer pages as a
 * route 5xx rise with nothing to fix. The designed shapes:
 *
 *   - `control_plane` 503 on a GET — the proxy answered `sandbox_not_ready`
 *     from the session-sandbox row without dialling the box (parked, stopped,
 *     or still provisioning), and a GET never wakes a box on purpose. The web
 *     app reads the response's `hop`/`code`, not this log line; the row itself
 *     carries the state. Prod, 24 h to 2026-09-29: ~40 such 503s a day on the
 *     data-path GET routes alone, each one the client's reconnect hydrate
 *     racing a park (KRTX-397).
 *   - `daemon` 503 on a GET where the daemon itself answered 503 — the box's
 *     own daemon answered `runtime_not_ready` while its opencode runtime
 *     restarts behind a live box, and the proxy passed it through on purpose
 *     (no retry; the client re-polls, the box recovers within seconds). The
 *     passthrough carries the attribution (forward/retry.ts), so the hop plus
 *     the upstream status tell this designed answer apart from every other
 *     503. Prod, 26 h to 2026-10-09: 8 such 503s, each inside a multi-route
 *     boot-window burst that recovered within seconds (KRTX-397
 *     reoccurrence).
 *   - `daemon` 503 on the session-abort verb (`POST .../session/:id/abort`) —
 *     the same designed boot-window answer on the one mutation whose failure
 *     is recovered by the client's own re-press (KRTX-2277).
 *   - long-poll/SSE event-stream reads (/global/event, /session/status,
 *     /session/:id/message) timing out at ~30 s (504), or the boot window
 *     answering 502/503.
 *   - sandbox startup probes (/global/health, /kortix/health, /sessions)
 *     answering 502/503/504 before services are ready.
 *
 * Everything else stays logged: a 502/503 the proxy dialled for
 * (`provider_ingress`/`upstream_port` hop, or no hop header at all — including
 * the daemon's 503s that carry no boot-phase signature), the give-up 502 (it
 * logs at its internal 502 with the honest `upstream_status` — the edge
 * rewrite to 503 happens after this line), any other mutation, and a FAILED
 * health probe. The wire response is untouched — suppression is about the log
 * line only, and the span is still emitted.
 */
export function shouldSuppressRequestLog(input: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Value of the `X-Kortix-Proxy-Hop` response header when the proxy set one. */
  proxyHop: string | null;
  /** Status the failing hop itself returned, from `X-Kortix-Upstream-Status`. */
  upstreamStatus: number | null;
}): boolean {
  const { method, path, status, durationMs, proxyHop, upstreamStatus } = input;
  if (method !== 'GET') {
    // The session-abort verb is the one mutation whose daemon boot-phase 503 is
    // the designed answer, not a failed user action (KRTX-2277): a Stop is
    // idempotent, carries no data, and the client re-presses it until the
    // runtime answers — the same client-side retry that covers the GET shapes
    // below. Prod, 2026-10-14: one wedged sandbox produced 22 such 503s in 40
    // minutes and the sweep paged them as a route 5xx rise on the abort verb.
    // Every other mutation stays logged: a message or prompt that 503s was NOT
    // delivered, and the give-up 502 is an outage signal.
    if (status !== 503 || proxyHop !== 'daemon' || upstreamStatus !== 503) return false;
    // The runtime verbs live in the path after the `/v1/p/<sandbox>/<port>`
    // prefix; classifyRuntimeRequest is the one classifier every proxy guard
    // asks (it also strips the in-box `/proxy/<port>` nesting).
    const bare = path.replace(/^\/v1\/p\/[^/]+\/\d+(?=\/)/, '');
    return classifyRuntimeRequest(method, bare).kind === 'abort';
  }
  if (status === 503 && proxyHop === 'control_plane') return true;
  // The daemon's own boot-phase answer: a 503 the proxy passed through
  // BECAUSE the daemon named `runtime_not_ready` — see sandbox-proxy/forward/
  // retry.ts. The upstream status must be the daemon's own 503: a give-up
  // logs at its 502 with that status in `X-Kortix-Upstream-Status`, and that
  // outage signal stays logged. So does an unattributed 503 and one without
  // an upstream status (every attempt threw — the port never answered).
  if (status === 503 && proxyHop === 'daemon' && upstreamStatus === 503) return true;
  const isSandboxProxyPath = path.includes('/v1/p/');
  const isProxyLongPoll =
    isSandboxProxyPath &&
    (path.includes('/global/event') ||
      path.includes('/session/status') ||
      /\/session\/[^/]+\/message(?:$|\?)/.test(path));
  const isProxyStartupProbe =
    isSandboxProxyPath &&
    (path.includes('/global/health') ||
      path.includes('/kortix/health') ||
      /\/sessions(?:\/|$)/.test(path));
  return (
    (isProxyLongPoll &&
      ((status === 200 && durationMs > 5000) ||
        status === 504 ||
        status === 502 ||
        status === 503)) ||
    (isProxyStartupProbe && (status === 502 || status === 503 || status === 504))
  );
}
