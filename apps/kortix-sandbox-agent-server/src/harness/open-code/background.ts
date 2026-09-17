import type { OpenCodeConfig as Config } from './config'
import { kortixEventBus } from '../../kortix-event-bus'
import { logger } from '../../logger'
import { startResourceMonitor, type ResourceMonitor } from '../../resources'
import type { Opencode } from './lifecycle'
import { OPENCODE_HOME } from './paths'
import { defaultSidecarDir, opencodeDbPath, runAttachmentOffloadPass } from './attachment-offload'
import { opencodeSessionInFlight, opencodeTurnInFlight, readPinnedSessionId } from './opencode-turn-state'
import { OpencodeDb } from './opencode-db'
import { QuickQueueInterrupt, quickQueueSnapshotFromPage } from './quick-queue-interrupt'
import {
  evaluateOpenCodePressure,
  findOpencodePids,
  formatOpenCodeMemoryGuardReason,
  formatOpenCodeResourceState,
  formatOpenCodeResourceTransition,
  projectOpenCodeResourceSnapshot,
} from './resource-diagnostics'

/** Quick Queue interrupt over the pinned OpenCode root; created once per service. */
export function createOpenCodeQuickQueueInterrupt(
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Pick<Config, 'workspace'>,
): QuickQueueInterrupt {
  const quickQueueDb = new OpencodeDb(opencodeDbPath(OPENCODE_HOME))
  const readQuickQueueSnapshot = async (input: {
    opencodeSessionId: string
    messageId: string
  }) => {
    if (readPinnedSessionId() !== input.opencodeSessionId) {
      return { state: 'stale' as const, runningTool: false }
    }
    const inFlight = await opencodeSessionInFlight(
      opencode.getInternalUrl(), cfg.workspace, input.opencodeSessionId,
    )
    if (!quickQueueDb.probe().supported) return { state: 'unknown' as const, runningTool: false }
    const page = quickQueueDb.messagePage({ sessionId: input.opencodeSessionId, limit: 12 })
    return quickQueueSnapshotFromPage(
      inFlight,
      page?.messages as Parameters<typeof quickQueueSnapshotFromPage>[1] ?? null,
      input.messageId,
    )
  }
  return new QuickQueueInterrupt({
    readSnapshot: readQuickQueueSnapshot,
    abort: async (input) => {
      // Recheck at the wire boundary: an older arm must not kill a later tool
      // or a new turn that began while the first snapshot was in flight.
      const snapshot = await readQuickQueueSnapshot(input)
      if (snapshot.state !== 'active' || snapshot.runningTool) return false
      const url =
        `${opencode.getInternalUrl()}/session/${encodeURIComponent(input.opencodeSessionId)}/abort` +
        `?directory=${encodeURIComponent(cfg.workspace)}`
      const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) })
      if (response.ok) logger.info('[quick-queue] interrupted at tool boundary', {
        promptId: input.promptId, messageId: input.messageId,
      })
      return response.ok
    },
  })
}

/** Native attachment upkeep and abort policy over host resource measurements. */
export function startOpenCodeBackground(
  opencode: Opencode,
  cfg: Config,
  quickQueue: Pick<QuickQueueInterrupt, 'observe' | 'stop'>,
): ResourceMonitor {
  const turnInFlight = () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace)
  // Attachment offload (attachment-offload.ts): inline image bytes out of the
  // transcript store, only while no turn runs. Every 5 min, and right after a
  // memory-guard abort.
  const offloadDbPath = opencodeDbPath(OPENCODE_HOME)
  const offloadSidecarDir = defaultSidecarDir(OPENCODE_HOME)
  const quickQueueEvents = kortixEventBus().subscribe((event) => {
    void quickQueue.observe(event)
  })
  let offloadRunning = false
  let stopped = false
  const runOffloadIfIdle = async (why: string): Promise<void> => {
    if (stopped || offloadRunning) return
    if (process.env.KORTIX_ATTACHMENT_OFFLOAD === '0') return
    offloadRunning = true
    try {
      if ((await turnInFlight()) !== false || stopped) return
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
  const offloadBootTimer = setTimeout(() => void runOffloadIfIdle('boot'), 90_000)
  offloadBootTimer.unref?.()

  const monitor = startResourceMonitor({
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
  // Stopping the background work stops the offload timers and the queue
  // interrupt too, so a proxy stop leaves no transcript read or abort behind.
  return {
    ...monitor,
    stop() {
      stopped = true
      quickQueueEvents.unsubscribe()
      quickQueue.stop()
      clearTimeout(offloadBootTimer)
      clearInterval(offloadTimer)
      monitor.stop()
    },
  }
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
