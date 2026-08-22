/**
 * The three workloads this binary runs, behind one interface.
 *
 * WHY THESE ARE THIN. `docs/specs/2026-08-21-kortixd.md` §12 rule 1: the
 * adapters are created by wrapping the existing orchestrators, not by rewriting
 * them. The bodies stay in `main.ts` for now and move in a later, separate
 * commit whose diff is a pure rename. That ordering is the whole lesson of the
 * 2026-07-30 rollback — a seam introduced by rewriting the thing it wraps is
 * how three regressions shipped behind a flag that was supposed to be off.
 *
 * WHY THEY EXIST AT ALL NOW. §12 rule 3: the interface must be proven by two
 * implementations before a third is designed. `monitor` and `warm-seed` already
 * exist and must fit it UNCHANGED. If either needed special-casing, the
 * interface would be wrong and the harness work (P3) could not start. They fit.
 */

import { logger } from '../logger'
import { registerAgentSwapBlocker, unregisterAgentSwapBlocker } from '../runtime-assets'
import type { PreflightResult, StopReason, Workload, WorkloadHealth, WorkloadId } from './workload'

/**
 * What a workload needs to supply. Everything optional has a safe default, so
 * a new workload cannot accidentally under-declare the two properties that
 * matter — `busy` and `stop`.
 */
export interface WorkloadSpec {
  readonly kind: WorkloadId
  /** Bring it up. Must be idempotent. */
  readonly start: () => Promise<void>
  /**
   * True while a restart would sever real work. REQUIRED — no default.
   *
   * A default of `() => false` would mean a new workload silently opts into
   * being killed mid-work by the convergence swap. Making it mandatory turns
   * that omission into a type error. See workload.ts.
   */
  readonly busy: () => boolean | null
  readonly health?: () => WorkloadHealth
  readonly preflight?: () => Promise<PreflightResult>
  readonly stop?: (reason: StopReason) => Promise<void>
}

/**
 * Wrap a spec as a Workload and register its swap blocker.
 *
 * Registration happens HERE rather than at each call site because that is the
 * bug this replaces: `registerAgentSwapBlocker` was called by side effect from
 * whichever module remembered to (today only `proxy.ts`, for pty), so a
 * workload that forgot simply had its live work killed by an update swap.
 */
export function createWorkload(spec: WorkloadSpec): Workload {
  const blockerName = `workload:${spec.kind}`
  // `null` (cannot tell) collapses to BUSY here, never to idle. The blocker API
  // is boolean; the safety rule is that uncertainty must never authorise a swap.
  registerAgentSwapBlocker(blockerName, () => spec.busy() !== false)

  return {
    kind: spec.kind,
    async preflight(): Promise<PreflightResult> {
      if (!spec.preflight) return { ok: true }
      try {
        return await spec.preflight()
      } catch (err) {
        // A preflight that throws must not look like a pass.
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    },
    start: spec.start,
    health(): WorkloadHealth {
      if (!spec.health) return { state: null }
      try {
        return spec.health()
      } catch {
        // Health is polled every few seconds by the control plane. It must
        // never throw its way into a 500 — an unknown state is `null`.
        return { state: null }
      }
    },
    busy: spec.busy,
    async stop(reason: StopReason): Promise<void> {
      // Drop the blocker FIRST, and unconditionally. A stopped workload must not
      // keep vetoing convergence — a warm seed whose capture never completed
      // would otherwise answer "busy" for the life of the box, so the node could
      // never converge again after adoption.
      unregisterAgentSwapBlocker(blockerName)
      if (!spec.stop) return
      try {
        await spec.stop(reason)
      } catch (err) {
        // Shutdown is best-effort by design; a failing stop must not prevent
        // the rest of the drain.
        logger.warn('[workload] stop failed', {
          workload: spec.kind,
          reason,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}

/**
 * The session workload — supervises a harness (today always opencode) and
 * serves its surface through the proxy.
 *
 * `busy` is the existing turn-in-flight check. It is deliberately conservative:
 * "cannot tell" must read as busy, because the cost of being wrong is killing a
 * live turn.
 */
export function sessionWorkload(deps: {
  start: () => Promise<void>
  turnInFlight: () => boolean | null
  opencodeState: () => 'ok' | 'starting' | 'down'
  stop?: (reason: StopReason) => Promise<void>
}): Workload {
  return createWorkload({
    kind: 'session',
    start: deps.start,
    busy: deps.turnInFlight,
    health: () => ({ state: deps.opencodeState() }),
    stop: deps.stop,
  })
}

/**
 * The monitor workload — supervises the project's monitor processes and never
 * starts a harness at all.
 *
 * `busy` is false on purpose. A monitor process is restart-tolerant by
 * construction: the runner already owns a restart budget and backoff, and the
 * box epoch makes a superseded boot's events unacceptable to ingest. So a
 * convergence swap costs at most a batch, and blocking updates on a box that is
 * never idle would mean a monitor box never converges at all.
 */
export function monitorWorkload(deps: {
  start: () => Promise<void>
  stop?: (reason: StopReason) => Promise<void>
}): Workload {
  return createWorkload({
    kind: 'monitor',
    start: deps.start,
    busy: () => false,
    health: () => ({ state: 'ok', detail: { workload: 'monitor' } }),
    stop: deps.stop,
  })
}

/**
 * The warm-seed workload — boots a session-less runtime so the platform can
 * capture a fully warm snapshot, then adopts the forked session's identity.
 *
 * `busy` is true until capture-ready. Swapping the daemon mid-capture would
 * abort the capture at its budget, and a template whose capture never completes
 * is the 2026-06-11 class of failure: every fork of it fails forever.
 */
export function warmSeedWorkload(deps: {
  start: () => Promise<void>
  captureReady: () => boolean
  stop?: (reason: StopReason) => Promise<void>
}): Workload {
  return createWorkload({
    kind: 'warm-seed',
    start: deps.start,
    busy: () => !deps.captureReady(),
    health: () => ({
      state: deps.captureReady() ? 'ok' : 'starting',
      detail: { workload: 'warm-seed', capture_ready: deps.captureReady() },
    }),
    stop: deps.stop,
  })
}
