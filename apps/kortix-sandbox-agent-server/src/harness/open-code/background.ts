import type { OpenCodeConfig as Config } from './config'
import { logger } from '../../logger'
import { startResourceMonitor, type ResourceMonitor } from '../../resources'
import type { Opencode } from './supervisor'
import { OPENCODE_HOME } from './paths'
import { defaultSidecarDir, opencodeDbPath, runAttachmentOffloadPass } from './attachment-offload'
import { opencodeTurnInFlight, readPinnedSessionId } from './opencode-turn-state'
import {
  evaluateOpenCodePressure,
  findOpencodePids,
  formatOpenCodeMemoryGuardReason,
  formatOpenCodeResourceState,
  formatOpenCodeResourceTransition,
  projectOpenCodeResourceSnapshot,
} from './resource-diagnostics'

/** Native attachment upkeep and abort policy over host resource measurements. */
export function startOpenCodeBackground(opencode: Opencode, cfg: Config): ResourceMonitor {
  const turnInFlight = () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace)
  // Attachment offload (attachment-offload.ts): inline image bytes out of the
  // transcript store, only while no turn runs. Every 5 min, and right after a
  // memory-guard abort.
  const offloadDbPath = opencodeDbPath(OPENCODE_HOME)
  const offloadSidecarDir = defaultSidecarDir(OPENCODE_HOME)
  let offloadRunning = false
  const runOffloadIfIdle = async (why: string): Promise<void> => {
    if (offloadRunning) return
    if (process.env.KORTIX_ATTACHMENT_OFFLOAD === '0') return
    offloadRunning = true
    try {
      if ((await turnInFlight()) !== false) return
      const result = await runAttachmentOffloadPass({ dbPath: offloadDbPath, sidecarDir: offloadSidecarDir })
      if (result.offloaded > 0) logger.info('[offload] moved attachment bytes out of the transcript', { why, ...result })
    } catch (err) {
      logger.warn('[offload] pass threw', { err: (err as Error).message })
    } finally {
      offloadRunning = false
    }
  }
  const offloadTimer = setInterval(() => void runOffloadIfIdle('interval'), 5 * 60_000)
  offloadTimer.unref?.()
  setTimeout(() => void runOffloadIfIdle('boot'), 90_000).unref?.()

  return startResourceMonitor({
    runtimePid: () => opencode.getPid(),
    discoverRuntimePids: findOpencodePids,
    pressure: evaluateOpenCodePressure,
    formatSnapshot: projectOpenCodeResourceSnapshot,
    formatState: formatOpenCodeResourceState,
    formatStateTransition: formatOpenCodeResourceTransition,
    runtimeState: () => opencode.getState(),
    diskPaths: [cfg.workspace, '/opt/kortix', '/tmp'],
    guard: {
      guardPct: Number(process.env.KORTIX_MEMORY_GUARD_PCT) || undefined,
      formatReason: formatOpenCodeMemoryGuardReason,
      turnInFlight,
      abortTurn: async (reason) => {
        const sessionId = readPinnedSessionId()
        if (!sessionId) return false
        const url =
          `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/abort` +
          `?directory=${encodeURIComponent(cfg.workspace)}`
        logger.error('[resources] memory guard aborting the running turn', { sessionId, reason })
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        return res.ok
      },
      onGuard: async ({ reason, snapshot, aborted }) => {
        // Tell the control plane in the same words the UI already renders for
        // a turn that ended in error, BEFORE OpenCode's own `session.error`
        // ("Aborted") can claim the turn end — the first end wins.
        await relayMemoryGuardTurnEnd({ reason, aborted, opencodeRssMb: snapshot.runtime?.rssMb ?? null })
        void runOffloadIfIdle('memory-guard')
      },
    },
  })
}

/**
 * Report a memory-guard abort to apps/api as the turn's end, in the shape
 * the turn-stream already accepts (`kind: 'end'`, `status: 'error'`), so the
 * ledger records `failed` with a reason that names memory and the UI shows
 * it. Sent BEFORE the abort lands: OpenCode's own `session.error` ("Aborted")
 * follows, and the turn-stream keeps the first end for a turn.
 */
export async function relayMemoryGuardTurnEnd(input: {
  reason: string
  aborted: boolean
  opencodeRssMb: number | null
}): Promise<boolean> {
  const projectId = process.env.KORTIX_PROJECT_ID
  const sessionId = process.env.KORTIX_SESSION_ID
  const token = process.env.KORTIX_TOKEN
  const apiUrl = (process.env.KORTIX_API_URL ?? '').replace(/\/+$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return false
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  try {
    const res = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'end',
        status: 'error',
        opencode_session_id: readPinnedSessionId() ?? undefined,
        error_name: 'SandboxMemoryGuard',
        error_message: input.reason,
        error_retryable: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    logger.warn('[resources] memory guard relayed to the control plane', {
      status: res.status,
      aborted: input.aborted,
      opencodeRssMb: input.opencodeRssMb,
    })
    return res.ok
  } catch (err) {
    logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    return false
  }
}
