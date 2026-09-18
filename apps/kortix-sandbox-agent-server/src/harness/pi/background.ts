/**
 * Box telemetry for a pi session. The "runtime process" IS the daemon, so the
 * monitor samples this pid; the memory guard aborts the running turn in place.
 */
import { logger } from '../../logger'
import { startResourceMonitor, type ResourceMonitor } from '../../resources'
import type { Config } from '../../config'
import type { PiRuntime } from './runtime'

export function startPiBackground(runtime: () => PiRuntime | null, cfg: Config): ResourceMonitor {
  return startResourceMonitor({
    runtimePid: () => process.pid,
    runtimeState: () => runtime()?.getState() ?? 'down',
    diskPaths: [cfg.workspace, '/opt/kortix', '/tmp'],
    guard: {
      guardPct: Number(process.env.KORTIX_MEMORY_GUARD_PCT) || undefined,
      turnInFlight: async () => runtime()?.busy() ?? null,
      abortTurn: async (reason) => {
        const rt = runtime()
        if (!rt) return false
        logger.error('[resources] memory guard aborting the running pi turn', { reason })
        return rt.abort()
      },
    },
  })
}
