import { loadConfig, resolveOpencodeConfigDir } from './config'
import { materializeRepo } from './git'
import { logger } from './logger'
import { createOpencodeSupervisor, waitForOpencodeReady } from './opencode'
import { startProxy } from './proxy'
import { installShutdownHandlers } from './shutdown'

async function main() {
  const bootTime = Date.now()
  const cfg = loadConfig()
  logger.info('[boot] kortix-sandbox-agent-server starting', {
    servicePort: cfg.servicePort,
    opencodeInternalPort: cfg.opencodeInternalPort,
    autoClone: cfg.autoClone,
  })

  if (cfg.autoClone) {
    try {
      await materializeRepo(cfg)
    } catch (err) {
      // Repo materialization failures are loud but non-fatal — the daemon
      // can still serve /kortix/health so callers can diagnose the failure.
      logger.error('[boot] repo materialization failed', err)
    }
  }

  const opencodeConfigDir = await resolveOpencodeConfigDir(cfg)
  logger.info('[boot] resolved opencode config dir', { opencodeConfigDir })

  const opencode = createOpencodeSupervisor(cfg, opencodeConfigDir)

  // Start opencode in the background. It's non-fatal if it never becomes ready:
  // /kortix/health will report `opencode: starting` and the reverse proxy will
  // return 503 instead of crashing the daemon. This is what lets us boot
  // locally (where the opencode binary may be missing) for smoke tests.
  await opencode.start()

  const server = startProxy(cfg, opencode, bootTime)
  installShutdownHandlers(opencode, server)

  logger.info('[boot] proxy up; waiting for opencode readiness in background', {
    servicePort: cfg.servicePort,
  })

  void (async () => {
    const ready = await waitForOpencodeReady(opencode)
    if (ready) {
      logger.info('[boot] opencode ready', { opencodePid: opencode.getPid() })
    } else {
      logger.warn('[boot] opencode did not become ready within deadline; supervisor still retrying', {
        opencodePid: opencode.getPid(),
      })
    }
  })()
}

main().catch((err) => {
  logger.error('[boot] fatal', err)
  process.exit(1)
})
