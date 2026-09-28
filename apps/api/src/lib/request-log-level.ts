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
