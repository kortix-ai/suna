// Severity and suppression of the post-request `Request completed:` line.
// `src/index.ts` owns the middleware that calls both.

/**
 * Severity of the post-request `Request completed:` line.
 *
 * WARN only when the request FAILED (`5xx`). The line was WARN whenever
 * `duration > 5000`, so any fleet-wide contention that pushed a successful read
 * past 5 s paged as a warn-class log anomaly on a request that had succeeded.
 *
 * Prod, 26 h to 2026-09-28: 174 WARN lines on `GET /v1/projects/:id/sessions/:id`,
 * all status 200/403/404 and none `5xx` (KRTX-627). A latency regression stays
 * covered by the infra-sweep's separate p95 detector, so INFO here loses no
 * signal; the line still carries `duration`.
 */
export function requestLogLevel(status: number): 'info' | 'warn' {
  return status >= 500 ? 'warn' : 'info';
}

/**
 * Whether the post-request `Request completed:` line is suppressed entirely as
 * expected sandbox-proxy noise — a designed answer, not a server failure.
 *
 * The Better Stack log sweep counts every line whose `status` is `>= 500` as a
 * 5xx of the route on the line, so a designed 5xx-shaped answer pages as a
 * route 5xx rise with nothing to fix. Three shapes are designed:
 *
 *   - `control_plane` 503 on a GET — the proxy answered `sandbox_not_ready`
 *     from the session-sandbox row without dialling the box (parked, stopped,
 *     or still provisioning), and a GET never wakes a box on purpose. The web
 *     app reads the response's `hop`/`code`, not this log line; the row itself
 *     carries the state. Prod, 24 h to 2026-09-29: ~40 such 503s a day on the
 *     data-path GET routes alone, each one the client's reconnect hydrate
 *     racing a park (KRTX-397).
 *   - long-poll/SSE event-stream reads (/global/event, /session/status,
 *     /session/:id/message) timing out at ~30 s (504), or the boot window
 *     answering 502/503.
 *   - sandbox startup probes (/global/health, /kortix/health, /sessions)
 *     answering 502/503/504 before services are ready.
 *
 * Everything else stays logged: a 502/503 the proxy dialled for
 * (`daemon`/`provider_ingress`/`upstream_port` hop, or no hop header at all),
 * any mutation, and a FAILED health probe. The wire response is untouched —
 * suppression is about the log line only, and the span is still emitted.
 */
export function shouldSuppressRequestLog(input: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Value of the `X-Kortix-Proxy-Hop` response header when the proxy set one. */
  proxyHop: string | null;
}): boolean {
  const { method, path, status, durationMs, proxyHop } = input;
  if (method !== 'GET') return false;
  if (status === 503 && proxyHop === 'control_plane') return true;
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
