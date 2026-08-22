/**
 * The workload seam.
 *
 * WHY. `main()` (324 lines, in a 2,760-line file) decides what this box is by
 * falling through inline `if` statements. The orchestrators it dispatches to —
 * `runWarmSeedMode`, `runMonitorMode`, `startSessionRuntime` — are already
 * separate top-level functions, but nothing typed the relationship between
 * them, which is why adding a fourth
 * workload (the App runtime) was harder than writing a separate 639-line Go
 * daemon, and why a second harness had to REPLACE the first instead of sitting
 * beside it — the 2026-07-30 rollback.
 *
 * This file is that seam. It changes no behaviour: `selectWorkloadId` returns
 * exactly what the existing branches select, asserted against them in
 * `__tests__/workload.test.ts`.
 *
 * See docs/specs/2026-08-21-kortixd.md §6.
 */

import type { Config } from '../config'

/**
 * What this node is doing. One id per runtime contract.
 *
 * `app` is declared but not yet implemented here — it is today a separate Go
 * binary (`apps/kortix-app-runtime`) and folds in at P4. It is named now so the
 * registry is honest about the full set rather than growing a special case
 * later.
 */
export type WorkloadId = 'session' | 'monitor' | 'warm-seed' | 'app'

/** Workloads this binary can actually run today. */
export const IMPLEMENTED_WORKLOADS: readonly WorkloadId[] = ['session', 'monitor', 'warm-seed']

export interface WorkloadHealth {
  /** Feeds `GET /kortix/health`. `null` when this workload reports no state. */
  readonly state: 'ok' | 'starting' | 'down' | null
  /** Extra fields merged into the health body. Must never carry a credential. */
  readonly detail?: Record<string, unknown>
}

export type StopReason = 'shutdown' | 'drain' | 'agent-swap' | 'release'

export interface PreflightResult {
  readonly ok: boolean
  /** Why not, when `ok` is false. One line, safe to log and to show an operator. */
  readonly reason?: string
}

/**
 * One runtime contract. Every workload implements this; nothing about a
 * workload may be special-cased outside its own module.
 */
export interface Workload {
  readonly kind: WorkloadId

  /**
   * Validate the environment before anything is spawned. Runs after config is
   * resolved and before `start`. A failing preflight must explain itself rather
   * than letting the workload half-start and report a confusing health state.
   */
  preflight(): Promise<PreflightResult>

  /** Bring the workload up. Must be idempotent — a claim can be retried. */
  start(): Promise<void>

  /** Folded into `GET /kortix/health`. Cheap; health is polled every few seconds. */
  health(): WorkloadHealth

  /**
   * Is a restart going to sever real work?
   *
   *   true   yes — do not swap
   *   false  definitely not — safe to swap
   *   null   CANNOT TELL — treated as busy
   *
   * `null` is not decoration. `requestAgentSwapIfIdle` already distinguishes
   * `'turn-in-flight'` from `'turn-state-unknown'` because its probe returns
   * `Promise<boolean | null>` (runtime-assets.ts), and the whole safety rule is
   * "cannot tell counts as busy". A binary `boolean` here would force every
   * implementation to collapse that at the call site — re-creating the
   * busy-blind verdict class that has already cost live turns.
   *
   * This is also the existing swap blocker promoted to a first-class member. It
   * used to be registered by side effect, which a workload could forget; that
   * omission is now a type error.
   */
  busy(): boolean | null

  /** Graceful stop. Must leave the node reusable by the next claim. */
  stop(reason: StopReason): Promise<void>
}

/**
 * Which workload this process is, for the branches that were extracted.
 *
 * NOT the whole of `main()`'s boot decision. `main()` has FOUR paths, and this
 * covers the first three:
 *
 *   1. KORTIX_WARM_SEED=1        -> 'warm-seed'   (extracted here)
 *   2. KORTIX_WORKLOAD=monitor   -> 'monitor'     (extracted here)
 *   3. otherwise                 -> 'session'     (extracted here)
 *   4. …then, INSIDE the session path, main.ts branches again on
 *      `KORTIX_SESSION_ID === '' && cfg.autoClone` and hands off to
 *      `armSeedAdoption()`, returning before the normal session runtime starts.
 *
 * Path 4 is a session workload that is UNCLAIMED — a warm-seed builder waiting
 * to be adopted. It is deliberately NOT a fourth workload id: it is the same
 * workload in a different lifecycle state, and the node model already has a name
 * for that state (see {@link isClaimed}). Modelling it as an id would mean two
 * ids for one runtime contract, which is exactly the kind of special case the
 * seam exists to prevent.
 *
 * It is called out because the seam's documentation being wrong about the code
 * it is a seam for is the failure mode spec §12 exists to prevent.
 *
 * Order is load-bearing and preserved exactly:
 *   1. `KORTIX_WARM_SEED=1` wins outright. A seed builder boots a session-less
 *      runtime for snapshot capture; it must never be mistaken for a session
 *      even though the rest of its env looks like one.
 *   2. `KORTIX_WORKLOAD=monitor` selects the monitor box.
 *   3. Everything else is a session. Unset, empty, and unrecognized all mean
 *      session — an older control plane that knows no workload names must keep
 *      booting sessions, so an unknown value can never fail closed here.
 */
export function selectWorkloadId(
  cfg: Pick<Config, 'workload'>,
  env: NodeJS.ProcessEnv = process.env,
): WorkloadId {
  if ((env.KORTIX_WARM_SEED ?? '').trim() === '1') return 'warm-seed'
  if (cfg.workload === 'monitor') return 'monitor'
  return 'session'
}

/**
 * Is this node CLAIMED by a session?
 *
 * A session workload with no `KORTIX_SESSION_ID` is a node that is up but has
 * not been assigned work — today that is the warm-seed builder awaiting
 * adoption (`armSeedAdoption`, main.ts), and in the node model it is simply the
 * `idle` state. Naming it here is what lets P1 generalize adoption into `claim`
 * without inventing a new concept.
 *
 * Reads the environment LIVE and never caches: adoption rewrites `process.env`
 * at runtime, so a cached answer is the deriving session's, not this one's.
 * See docs/specs/2026-08-21-kortixd.md §5.3.1.
 */
export function isClaimed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KORTIX_SESSION_ID ?? '').trim().length > 0
}
