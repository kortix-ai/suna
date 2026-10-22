/**
 * Is this process, right now, on its way out?
 *
 * DEF-A 2026-09-26: a config convergence's candidate OpenCode is a child of
 * THIS process. When a staged daemon update wins the race and this process
 * starts exiting, `harness.stop()` (app/shutdown.ts) kills that candidate
 * along with everything else — and from inside `reloadVerified` a candidate
 * SIGTERMed by our own shutdown is indistinguishable from one that genuinely
 * never came up: both report `cause: null`. `config-release.ts` cannot tell the
 * difference by symptom, so the shutdown path states the fact directly: it
 * is the one thing that actually knows, because it is the thing calling
 * `stop()`. The flag lives here, in lib/, so an adapter can read it without
 * importing app/.
 *
 * Module-level, not a closure local: one daemon process calls
 * `installShutdownHandlers` exactly once, and the reader must see the same
 * flag the installer sets regardless of which module asks.
 */
let shuttingDown = false

export function isDaemonShuttingDown(): boolean {
  return shuttingDown
}

/** Test seam: one bun process runs every daemon test file. */
export function resetDaemonShutdownStateForTests(): void {
  shuttingDown = false
}

/**
 * Test seam: simulate the daemon being mid-shutdown without driving a real
 * `installShutdownHandlers()` teardown (which awaits `harness.stop()` and
 * calls `exit()`). Used by `config-release-converge.test.ts` to prove DEF-A
 * at the seam that actually raced, without booting the whole daemon.
 */
export function __setDaemonShuttingDownForTests(value: boolean): void {
  shuttingDown = value
}

/** The shutdown path's claim: true once, for the first caller; false after. */
export function beginDaemonShutdown(): boolean {
  if (shuttingDown) return false
  shuttingDown = true
  return true
}
