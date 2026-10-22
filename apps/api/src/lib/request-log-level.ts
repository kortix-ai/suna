// Severity, suppression, and timing breakdown of the post-request
// `Request completed:` line. `src/http-middleware.ts` owns the middleware that calls them.

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

/** Per-statement db wall past which the db stage reads as connection-pool
 *  queueing rather than statement cost. Prod statements are ~2.5 ms server-side
 *  (KRTX-532's pg_stat_statements cross-check) and the chronically contended
 *  200 tail sat near ~275 ms per statement, while every 25 s deadline death of
 *  the 2026-10-04 saturation episode measured 1.6–3.6 s per statement
 *  (KRTX-1571). 1 s sits between the two regimes. */
const DB_POOL_WAIT_SUSPECT_MS_PER_STATEMENT = 1_000;

const DB_STAGE_RE = /\bdb;dur=(\d+);desc="n=(\d+)"/;

/**
 * Whether a slow completion's `Server-Timing` breakdown reads as the request
 * having queued for a db pool connection instead of running expensive
 * statements — `db;dur ÷ n` far above per-statement exec cost.
 *
 * KRTX-1571 (prod, 2026-10-04): `GET /v1/projects/:id` 5xx'd 503s whose own
 * completion lines carried `db;dur=20755;desc="n=6"` — ~3.5 s per statement
 * for statements that execute in ~2.5 ms, i.e. the request spent its budget
 * waiting for a pool connection. Attributing that from the raw `server_timing`
 * string took a manual division plus the pg_stat_statements cross-check; this
 * derives the same verdict per line so the NEXT saturation episode names
 * itself in one grep (`db_pool_wait_suspected: true`) instead of a
 * four-session investigation. Only the `db` stage counts: auth/iam wall is
 * mostly the same statements (stages overlap), and an `n`-less or unparseable
 * entry proves nothing.
 */
export function dbPoolWaitSuspected(serverTiming: string): boolean {
  const match = DB_STAGE_RE.exec(serverTiming);
  if (!match) return false;
  const statements = Number.parseInt(match[2], 10);
  if (!Number.isFinite(statements) || statements <= 0) return false;
  return Number.parseInt(match[1], 10) / statements >= DB_POOL_WAIT_SUSPECT_MS_PER_STATEMENT;
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
