/**
 * Box telemetry for a pi session. The "runtime process" IS the daemon, so the
 * monitor samples this pid; the memory guard prefers SHEDDING a runaway child
 * (a `bash` tool's `docker`/`pnpm`/build process pi moved on from) over
 * ending the turn, and aborts the turn in place only once shedding is
 * exhausted (see `resources.ts` `pickShedCandidate`).
 */
import { logger } from '../../logger'
import { relayMemoryGuardTurnEnd } from '../../memory-guard-relay'
import { startResourceMonitor, type ResourceMonitor } from '../../resources'
import type { Config } from '../../config'
import type { PiRuntime } from './runtime'

export function startPiBackground(runtime: () => PiRuntime | null, cfg: Config): ResourceMonitor {
  // Captured inside `abortTurn`, BEFORE it runs: aborting clears the active
  // turn, so `onGuard` (which fires after) can no longer read it off `rt`.
  let guardedRootId: string | null = null
  let guardedTurnMessageId: string | null = null
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
        guardedRootId = rt.rootId
        guardedTurnMessageId = rt.activeTurnMessageId()
        logger.error('[resources] memory guard aborting the running pi turn', { reason })
        return rt.abort()
      },
      onGuard: async ({ reason, aborted, snapshot, shed }) => {
        // A shed that kept the turn running has nothing to report as a turn
        // end — apps/api would drop it as non-terminal anyway, and the local
        // `[resources] memory guard shed a runaway process` log already names
        // the cause. Only an abort ATTEMPT (successful or not) is a turn-end
        // candidate worth the round trip.
        if (shed.length > 0) return
        await relayMemoryGuardTurnEnd({
          reason,
          aborted,
          opencodeRssMb: snapshot.runtime?.rssMb ?? null,
          opencodeSessionId: guardedRootId,
          turnMessageId: guardedTurnMessageId,
        })
      },
    },
  })
}
