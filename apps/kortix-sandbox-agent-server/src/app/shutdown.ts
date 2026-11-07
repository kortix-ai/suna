import { shredAgentEnvFile } from '@/harness/shared/agent-env-file'
import { stopSessionLogJournal } from '@/harness/shared/session-log-journal'
import { flushDriveSyncOnShutdown } from '@/services/drive-sync/drive-sync'
import { stopEgressShim } from '@/services/egress-shim'
import { logger } from '@/lib/log/logger'
import { beginDaemonShutdown } from '@/lib/shutdown-state'
import type { HarnessLifecycleService } from '@/harness/harness'
import type { ProxyServer } from './server'
import type { DaemonShutdown } from '@/harness/contract/server'
import type { StaticWebServer } from '@/services/static-web/static-web'

/**
 * The most a shutdown waits for the harness to stop. The proxy is already closed by then, so a
 * stop that never settles (a tool that ignores its abort) must not leave a daemon that serves
 * nothing and never exits: the supervisor restarts an exited daemon.
 */
export const SHUTDOWN_HARNESS_STOP_MS = 20_000

let installedSignalHandlers: { term: () => void; int: () => void } | null = null

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
      // Drive changes not yet on the drive, and session-log changes not yet
      // acknowledged (at most 3 s), go up before anything stops: the journal
      // reads the harness's native store, so it runs before harness.stop().
      await Promise.all([flushDriveSyncOnShutdown().catch(() => {}), stopSessionLogJournal().catch(() => {})])
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
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const stopped = await Promise.race([
          harness.stop(signal).then(() => true),
          new Promise<false>((resolve) => {
            deadline = setTimeout(() => resolve(false), SHUTDOWN_HARNESS_STOP_MS)
          }),
        ])
        if (!stopped) logger.warn('[shutdown] the harness did not stop in time; exiting without it', { ms: SHUTDOWN_HARNESS_STOP_MS })
      } catch (err) {
        logger.warn('[shutdown] harness stop failed', err)
      } finally {
        clearTimeout(deadline)
      }
      logger.info('[shutdown] done', { reason, exitCode })
      exit(exitCode)
    })()
  }

  // One pair of listeners per process: a second install replaces the first.
  if (installedSignalHandlers) {
    process.off('SIGTERM', installedSignalHandlers.term)
    process.off('SIGINT', installedSignalHandlers.int)
  }
  installedSignalHandlers = { term: () => stop('SIGTERM', 0, 'SIGTERM'), int: () => stop('SIGINT', 0, 'SIGINT') }
  process.on('SIGTERM', installedSignalHandlers.term)
  process.on('SIGINT', installedSignalHandlers.int)

  return ({ reason, exitCode = 0, signal = 'SIGTERM' }) => stop(reason, exitCode, signal)
}
