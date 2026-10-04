// Severity, suppression, and timing breakdown of the post-request
// `Request completed:` line. `src/http/middleware/http-middleware.ts` owns the middleware that calls them.

import { formatStageEntries, stageSnapshot } from './server-timing';

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
 * Default duration past which a completed request logs its per-stage
 * wall-time breakdown. Operator-tunable with `KORTIX_SLOW_REQUEST_TIMING_MS`
 * (log volume on the slow tail is an operator concern, not a code one).
 */
const SLOW_REQUEST_TIMING_MS_DEFAULT = 1_000;

/**
 * The `Server-Timing` stage entries (`auth;dur=…;desc="n=…", db;dur=…, …`) for
 * the completed log line, or an empty string on a fast success.
 *
 * The stages are computed on EVERY request (lib/server-timing.ts) and shipped
 * as a response header — which reaches only the client. When a fleet-wide p95
 * anomaly fires (KRTX-468: `GET /:id/sessions` p95 610 → 1720 ms on prod DB
 * contention), the log line carried one opaque `duration`, and attributing it
 * was a post-hoc ClickHouse reconstruction. Logging the breakdown on the
 * slow-or-failed tail answers "DB stretch, IAM work, or an upstream wait" from
 * the line itself.
 *
 * Slow tail and 5xx only: a healthy 200 at 30 ms gains nothing from six extra
 * fields and the Better Stack line budget is real. This enriches the EXISTING
 * line — no new log pattern to page on.
 */
export function requestTimingLogField(durationMs: number, status: number): string {
  const raw = Number.parseInt(process.env.KORTIX_SLOW_REQUEST_TIMING_MS ?? '', 10);
  const threshold = Number.isFinite(raw) && raw >= 0 ? raw : SLOW_REQUEST_TIMING_MS_DEFAULT;
  if (durationMs < threshold && status < 500) return '';
  return formatStageEntries(stageSnapshot()).join(', ');
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

const CLIENT_VERSION_RE = /^[0-9a-z][0-9a-z.+/-]{0,63}$/i;
const CREDENTIAL_PREFIX_RE = /^(?:sk-|gh[opusr]_|kortix_(?:pat|sbx)_)/i;

/**
 * The caller's self-reported `<surface>/<version>` (`X-Kortix-Client-Version`,
 * e.g. `cli/0.13.42`) for the `Request completed:` line, so a route or alias
 * can be retired once no supported client version calls it. Telemetry only:
 * any client can send any value, so it never reaches the audit trail, which
 * records the authenticated credential. A missing, malformed or
 * credential-shaped value is omitted.
 */
export function requestClientLogFields(
  header: (name: string) => string | undefined,
): { client_version?: string } {
  const value = header('x-kortix-client-version')?.trim() ?? '';
  if (!CLIENT_VERSION_RE.test(value) || CREDENTIAL_PREFIX_RE.test(value)) return {};
  return { client_version: value };
}
