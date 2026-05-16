import { logger } from './logger'
import type { Opencode } from './opencode'
import type { ProxyServer } from './proxy'

export function installShutdownHandlers(opencode: Opencode, proxy: ProxyServer) {
  let shuttingDown = false

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('[shutdown] signal received', { signal })

    void (async () => {
      try {
        await proxy.stop()
      } catch (err) {
        logger.warn('[shutdown] proxy stop failed', err)
      }
      try {
        await opencode.stop(signal)
      } catch (err) {
        logger.warn('[shutdown] opencode stop failed', err)
      }
      logger.info('[shutdown] done')
      process.exit(0)
    })()
  }

  process.on('SIGTERM', () => handle('SIGTERM'))
  process.on('SIGINT', () => handle('SIGINT'))
}
