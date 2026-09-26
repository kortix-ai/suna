import { shredAgentEnvFile } from './agent-env-file'
import { stopEgressShim } from './egress-shim'
import { logger } from './logger'
import type { HarnessLifecycleService } from './harness/harness'
import type { ProxyServer } from './proxy'
import type { StaticWebServer } from './static-web'

/**
 * Stop the daemon cleanly, and choose the exit code.
 *
 * The code is load-bearing for the entrypoint supervisor: `75` means "install
 * the staged binary and start me again", anything else non-zero counts against
 * the failure budget that triggers a rollback. See
 * apps/sandbox/entrypoint.sh and src/runtime-assets.ts.
 *
 * A self-update MUST come through here rather than calling `process.exit`
 * directly: opencode is a child of this process, and leaving it alive would
 * hand the relaunched daemon a port that is already taken.
 */
export interface DaemonShutdown {
  (opts: { reason: string; exitCode?: number; signal?: NodeJS.Signals }): void
}

/**
 * Is this process, right now, on its way out?
 *
 * DEF-A 2026-09-26: a config convergence's candidate OpenCode is a child of
 * THIS process. When a staged daemon update wins the race and this process
 * starts exiting, `harness.stop()` below kills that candidate along with
 * everything else — and from inside `reloadVerified` a candidate SIGTERMed by
 * our own shutdown is indistinguishable from one that genuinely never came
 * up: both report `cause: null`. `config-release.ts` cannot tell the
 * difference by symptom, so this module states the fact directly: it is the
 * one thing that actually knows, because it is the thing calling `stop()`.
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

export function installShutdownHandlers(
  harness: Pick<HarnessLifecycleService, 'stop'>,
  proxy: ProxyServer,
  staticWeb?: StaticWebServer,
  deps: { exit?: (code: number) => void } = {},
): DaemonShutdown {
  const exit = deps.exit ?? ((code: number) => process.exit(code))

  const stop = (reason: string, exitCode: number, signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('[shutdown] stopping', { reason, exitCode })
    shredAgentEnvFile()
    // Stops the listener and drops the CA private key, which lives only in
    // memory and is never written to disk. A hibernated or archived disk must
    // not be able to yield a CA that can still impersonate a policy host.
    stopEgressShim()

    void (async () => {
      try {
        await proxy.stop()
      } catch (err) {
        logger.warn('[shutdown] proxy stop failed', err)
      }
      if (staticWeb) {
        try {
          await staticWeb.stop()
        } catch (err) {
          logger.warn('[shutdown] static-web stop failed', err)
        }
      }
      try {
        await harness.stop(signal)
      } catch (err) {
        logger.warn('[shutdown] harness stop failed', err)
      }
      logger.info('[shutdown] done', { reason, exitCode })
      exit(exitCode)
    })()
  }

  process.on('SIGTERM', () => stop('SIGTERM', 0, 'SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT', 0, 'SIGINT'))

  return ({ reason, exitCode = 0, signal = 'SIGTERM' }) => stop(reason, exitCode, signal)
}
