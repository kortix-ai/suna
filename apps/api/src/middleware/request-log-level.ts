/**
 * The level of the per-request `Request completed:` log line.
 *
 * `warn` means the request FAILED — a 5xx. A successful response stays `info`
 * even when it is slow. `_durationMs` is passed so the invariant is explicit
 * and testable: latency never raises the level.
 *
 * Latency is not a failure. `duration` is already in the message, in the OTel
 * span (`http.response.duration_ms`) and in the HTTP metrics, and the log
 * sweep computes p95 latency from it. A `duration > 5000` that forced `warn`
 * on a 2xx made every slow-but-successful endpoint — a config write-through
 * that commits `kortix.yaml` and re-syncs connectors, a large list — look like
 * a new warn pattern to the log sweep, which filed a phantom issue. See
 * KRTX-641.
 */
export function requestCompletedLevel(status: number, _durationMs: number): 'info' | 'warn' {
  return status >= 500 ? 'warn' : 'info';
}
