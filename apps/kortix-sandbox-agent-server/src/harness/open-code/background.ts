import type { OpenCodeConfig as Config } from './config'
import { kortixEventBus } from '../../kortix-event-bus'
import { logger } from '../../logger'
import { startResourceMonitor, type ResourceMonitor } from '../../resources'
import type { Opencode } from './lifecycle'
import { OPENCODE_HOME } from './paths'
import { defaultSidecarDir, opencodeDbPath, runAttachmentOffloadPass } from './attachment-offload'
import {
  TURN_PROBE_WINDOW,
  opencodeSessionInFlight,
  opencodeTurnInFlight,
} from './opencode-turn-state'
import { readOpenCodeSessionPin } from './runtime-state'
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
    if (readOpenCodeSessionPin() !== input.opencodeSessionId) {
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
  // The root the guard aborted and the turn that was running on it. The relay
  // names both. The turn is read BEFORE the abort, and only while it is still
  // open: after the abort the newest turn can be a queued prompt, and a finished
  // turn must never be blamed for an abort that came later. One small SQLite row
  // first — the HTTP transcript can be tens of MB at the moment memory is at its
  // worst — and the transcript window only when that store cannot be read.
  const turnDb = new OpencodeDb(offloadDbPath)
  let guardedSessionId: string | null = null
  let guardedTurnMessageId: string | null = null
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
        const sessionId = readOpenCodeSessionPin()
        guardedSessionId = sessionId
        guardedTurnMessageId = null
        if (!sessionId) return false
        // `null` from the store is "no open turn" OR "could not read"; the
        // transcript settles which, and only costs a read in that rare case.
        guardedTurnMessageId =
          (turnDb.probe().supported ? turnDb.openTurnMessageId(sessionId) : null) ??
          (await readOpenTurnMessageId(opencode.getInternalUrl(), cfg.workspace, sessionId))
        const url =
          `${opencode.getInternalUrl()}/session/${encodeURIComponent(sessionId)}/abort` +
          `?directory=${encodeURIComponent(cfg.workspace)}`
        logger.error('[resources] memory guard aborting the running turn', { sessionId, reason })
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        return res.ok
      },
      onGuard: async ({ reason, snapshot, aborted }) => {
        // Tell the control plane why the turn ended. Sent after the abort, so
        // OpenCode's own "Aborted" end frame races this one. Either order ends
        // the same: apps/api lets a named cause replace the abort that beat it.
        await relayMemoryGuardTurnEnd({
          reason,
          aborted,
          opencodeRssMb: snapshot.runtime?.rssMb ?? null,
          opencodeSessionId: guardedSessionId,
          turnMessageId: guardedTurnMessageId,
        })
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
 * it. apps/api closes a turn only when the frame names it (`turn_message_id`);
 * an unnamed frame settles as `identity_mismatch` and the reason is lost.
 */
export async function relayMemoryGuardTurnEnd(input: {
  reason: string
  aborted: boolean
  opencodeRssMb: number | null
  opencodeSessionId: string | null
  /** The turn that was running when the guard fired, read before the abort. */
  turnMessageId: string | null
}): Promise<boolean> {
  const projectId = process.env.KORTIX_PROJECT_ID
  const sessionId = process.env.KORTIX_SESSION_ID
  const token = process.env.KORTIX_TOKEN
  const apiUrl = (process.env.KORTIX_API_URL ?? '').replace(/\/+$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return false
  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  // Name the turn only when the abort landed: a named end closes the turn,
  // and a failed abort leaves it running.
  const turnMessageId = input.aborted ? input.turnMessageId : null
  try {
    const res = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'end',
        status: 'error',
        opencode_session_id: input.opencodeSessionId ?? undefined,
        turn_message_id: turnMessageId ?? undefined,
        error_name: 'SandboxMemoryGuard',
        error_message: input.reason,
        // An aborted turn is over. apps/api reads `true` as "a retry, still
        // running" and drops the frame as `non_terminal`; that is only the
        // truth when the abort did not land.
        error_retryable: !input.aborted,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    logger.warn('[resources] memory guard relayed to the control plane', {
      status: res.status,
      turnMessageId,
      aborted: input.aborted,
      opencodeRssMb: input.opencodeRssMb,
    })
    return res.ok
  } catch (err) {
    logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    return false
  }
}

/**
 * `OpencodeDb.openTurnMessageId` over HTTP, for a store this daemon cannot read:
 * the user message of the turn that is running, or `null`. Same rule — the
 * newest assistant message must still be open.
 */
async function readOpenTurnMessageId(
  baseUrl: string,
  workspace: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const url =
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/message` +
      `?directory=${encodeURIComponent(workspace)}&limit=${TURN_PROBE_WINDOW}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{
      info?: {
        role?: string
        parentID?: string
        time?: { completed?: number }
        error?: { data?: { isRetryable?: boolean } }
      }
    }>
    if (!Array.isArray(rows)) return null
    // A plain loop: apps/api type-checks this file against a lib without `findLast`.
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (info?.role !== 'assistant') continue
      const open = info.time?.completed == null && (!info.error || info.error.data?.isRetryable === true)
      return open ? (info.parentID ?? null) : null
    }
    return null
  } catch {
    return null
  }
}
