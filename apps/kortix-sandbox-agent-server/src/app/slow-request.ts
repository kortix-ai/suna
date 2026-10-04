/**
 * Log the rare request whose handler takes seconds INSIDE the daemon, with
 * what the wall time went to.
 *
 * WHY (KRTX-472, 2026-09-29). The API's preview proxy splits a request into
 * `upstream_ms` (waiting on this daemon) and its own work. Its logs show
 * multi-second upstream waits every day: 218 sandbox health checks over 3 s
 * across 66 boxes in 48 h (p95 15 s, max 31 s), plus file reads and even
 * zero-I/O 403/404 answers taking 5-16 s. From the API side those waits are
 * one opaque number — provider edge, box and this process together — and this
 * daemon kept no per-request timing, so the next wedge is unattributable the
 * same way. This middleware makes each slow request self-describing:
 *
 *   - `cpuMs` ≈ `wallMs` → this process burned the time (look for sync work).
 *   - `cpuMs` ≪ `wallMs` and `load1` at the box's vCPU count → the box was
 *     pegged by another process (runtime/agent work) and this one starved.
 *   - `cpuMs` ≈ 0 and `load1` low → the process barely ran: a suspend/resume
 *     freeze (wall advances through a Platinum freeze, runtime-truth Rule 3.2)
 *     or a handler awaiting a wedged upstream (runtime proxy, /vcs/diff).
 *
 * Slow-only. The healthy path pays one `performance.now()` pair; per-request
 * lines would flood the bounded daemon log (the UI polls /vcs/diff every few
 * seconds). `warn` is safe here because the daemon log never ships to Better
 * Stack — unlike the API, which keeps slow-but-successful at INFO for exactly
 * that reason (KRTX-627). Reads the request log through `GET /kortix/logs`
 * (lib/log/logger's file sink).
 */

import type { MiddlewareHandler } from 'hono'
import { loadavg } from 'node:os'
import { logger } from '@/lib/log/logger'

/** A request whose handler took at least this long is logged with its wall/CPU split. */
const SLOW_REQUEST_MS = 2_000

/**
 * Wrap the whole daemon app, auth gates included. The threshold is a normal
 * factory parameter (no test-only mode): tests pass a small value.
 */
export function slowRequestLogger(thresholdMs: number = SLOW_REQUEST_MS): MiddlewareHandler {
  return async (c, next) => {
    const startCpu = process.cpuUsage()
    const startWall = performance.now()
    try {
      await next()
    } finally {
      const wallMs = performance.now() - startWall
      if (wallMs >= thresholdMs) {
        // The observer must never break the request (same rule as the SSE
        // byte counter): a slow request whose logging throws still completes.
        try {
          const cpu = process.cpuUsage(startCpu)
          const [load1Raw] = loadavg()
          logger.warn('[slow-request] handler exceeded threshold', {
            method: c.req.method,
            // Never persist a path that can contain a customer file name or id.
            route: c.req.routePath,
            status: c.res?.status ?? 0,
            wallMs: Math.round(wallMs),
            cpuMs: Math.round((cpu.user + cpu.system) / 1000),
            load1: Number((load1Raw ?? 0).toFixed(2)),
          })
        } catch {
          // Nothing sane to log into — fall back to a raw stderr line.
          process.stderr.write('[slow-request] logging failed\n')
        }
      }
    }
  }
}
