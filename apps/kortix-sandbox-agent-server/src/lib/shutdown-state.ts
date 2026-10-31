/**
 * One shutdown per daemon process. `installShutdownHandlers` (app/shutdown.ts)
 * claims it; a second request (a SIGTERM during an agent swap) is a no-op.
 * Module-level so every caller sees the same claim.
 */
let shuttingDown = false

/** Test seam: one bun process runs every daemon test file. */
export function resetDaemonShutdownStateForTests(): void {
  shuttingDown = false
}

/** The shutdown path's claim: true once, for the first caller; false after. */
export function beginDaemonShutdown(): boolean {
  if (shuttingDown) return false
  shuttingDown = true
  return true
}
