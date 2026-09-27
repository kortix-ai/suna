import { shredAgentEnvFile } from '../services/harness/shared/agent-env-file'
import { stopEgressShim } from '../services/egress-shim'
import { logger } from '../lib/log/logger'
import { beginDaemonShutdown } from '../lib/shutdown-state'
import type { HarnessLifecycleService } from '../services/harness/harness'
import type { ProxyServer } from './server'
import type { DaemonShutdown } from '../services/harness/contract/server'
import type { StaticWebServer } from '../services/static-web/static-web'

export function installShutdownHandlers(
  harness: Pick<HarnessLifecycleService, 'stop'>,
  proxy: ProxyServer,
  staticWeb?: StaticWebServer,
  deps: { exit?: (code: number) => void } = {},
): DaemonShutdown {
  const exit = deps.exit ?? ((code: number) => process.exit(code))

  const stop = (reason: string, exitCode: number, signal: NodeJS.Signals) => {
    if (!beginDaemonShutdown()) return
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
