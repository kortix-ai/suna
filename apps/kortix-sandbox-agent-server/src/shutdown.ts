import { shredAgentEnvFile } from './agent-env-file'
import { stopEgressShim } from './egress-shim'
import { logger } from './logger'
import type { Opencode } from './opencode'
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

export function installShutdownHandlers(
  opencode: Opencode,
  proxy: ProxyServer,
  staticWeb?: StaticWebServer,
): DaemonShutdown {
  let shuttingDown = false

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
        await opencode.stop(signal)
      } catch (err) {
        logger.warn('[shutdown] opencode stop failed', err)
      }
      logger.info('[shutdown] done', { reason, exitCode })
      process.exit(exitCode)
    })()
  }

  process.on('SIGTERM', () => stop('SIGTERM', 0, 'SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT', 0, 'SIGINT'))

  return ({ reason, exitCode = 0, signal = 'SIGTERM' }) => stop(reason, exitCode, signal)
}
