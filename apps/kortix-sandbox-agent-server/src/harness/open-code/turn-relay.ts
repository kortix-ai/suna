import { relayTurnBegin, relayTurnEnd, resetTurnBeginRelaysForTests } from '../shared/turn-relay'
import { noteOpencodeStopRequested } from './instance-guard'
import { logger } from '@/lib/log/logger'
import { readControlPlaneEnv, sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { noteControlPlaneResponse, sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import { flattenOpencodeError, type OpencodeTurnError } from './events'
import { observeIdleForRunaway } from './runaway-turn-guard'
import { readOpenCodeSessionPin } from './runtime-state'
import type { OpenCodeConfig as Config } from './config'
import type { Opencode } from './lifecycle'

// Relay a turn ending (opencode `session.idle` / `session.error`) for the ROOT
const relayedTurnSignatures = new Set<string>()

/** Test-only: clear the per-turn dedup set between cases. */
export function __resetRelayedTurnSignatures(): void {
  relayedTurnSignatures.clear()
}

// Turn-begin relay dedup: root id -> the newest user message id already
// relayed (or refused as already-known by apps/api). A turn's identity is its
// user message, so one turn relays once no matter how many `busy`/`retry`
// status frames it emits. Per-process, like `relayedTurnSignatures`.
const turnBeginRelaysInFlight = new Set<string>()

/** Test-only: clear the per-turn begin dedup between cases. */
export function __resetRelayedTurnBegins(): void {
  resetTurnBeginRelaysForTests()
  turnBeginRelaysInFlight.clear()
}

/**
 * What a busy/retry frame does. Busy is the pickup the first turn's acceptance
 * waits for, so it promotes the token apps/api minted before the box existed
 * now, not on the next reconcile tick. While that record is unsettled,
 * `turn_begin` must not run: the ledger has no row for the first message yet,
 * so the API would adopt it under a second token beside the pending one.
 */
export async function relayTurnBeginAfterInitialAcceptance(input: {
  initialAcceptancePending: () => boolean
  reconcileInitialAcceptance: () => Promise<void>
  relayTurnBegin: () => Promise<void>
}): Promise<'relayed' | 'deferred'> {
  if (input.initialAcceptancePending()) {
    await input.reconcileInitialAcceptance()
    if (input.initialAcceptancePending()) return 'deferred'
  }
  await input.relayTurnBegin()
  return 'relayed'
}

/**
 * Announce a BOX-INITIATED turn to apps/api (`turn-stream` kind `turn_begin`).
 *
 * Every control-plane prompt gets its `session_turns` row BEFORE delivery, but
 * OpenCode also starts turns nobody delivered — the synthetic `<pty_exited>`
 * user message it injects when a background pty finishes. Those turns had no
 * authority at all: `GET .../turn` read idle over minutes of live streaming
 * and the box ran on its 15-minute idle tail (live incident 2026-08-20,
 * a reported session). This relay fires on the root's `busy`/`retry`
 * status frames and names the newest user message; apps/api adopts it only
 * when no open turn exists and the message was never seen — so relaying for
 * an ordinary delivered prompt is a cheap no-op.
 */
export async function relayTurnBeginToApi(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<void> {
  // The session credential is bound to this sandbox's session_id. The API
  // treats that claim as the daemon identity for lifecycle-only callbacks.
  if (!readControlPlaneEnv().token) return
  const ctx = sandboxRelayContext()
  if (!ctx) return
  if (turnBeginRelaysInFlight.has(opencodeSessionId)) return
  turnBeginRelaysInFlight.add(opencodeSessionId)
  try {
    if (!(await isRootOpencodeSession(opencodeSessionId, opencode, cfg))) return
    // The newest USER message names the turn that is running.
    let newestUserId: string | null = null
    try {
      const res = await fetch(
        `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/message?directory=${encodeURIComponent(cfg.workspace)}`,
        { signal: AbortSignal.timeout(5_000) },
      )
      if (!res.ok) return
      const rows = (await res.json()) as Array<{ info?: { id?: string; role?: string } }>
      if (!Array.isArray(rows)) return
      for (let i = rows.length - 1; i >= 0; i--) {
        const info = rows[i]?.info
        if (info?.role === 'user' && typeof info.id === 'string') {
          newestUserId = info.id
          break
        }
      }
    } catch {
      return
    }
    if (!newestUserId) return

    if (sessionTokenPresumedDead()) return
    await relayTurnBegin(opencodeSessionId, newestUserId)
  } finally {
    turnBeginRelaysInFlight.delete(opencodeSessionId)
  }
}

export async function relayTurnEndToApi(
  opencodeSessionId: string,
  status: 'idle' | 'error',
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
  eventError?: OpencodeTurnError,
): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return

  // Resolve the turn's error + completed signature in one read. session.error
  let turn = await readRootTurnState(opencodeSessionId, opencode, cfg)
  let error = eventError ?? turn.error
  let effectiveStatus = error ? 'error' : status
  let rootClassification = await classifyOpencodeSession(opencodeSessionId, opencode, cfg)
  for (let attempt = 2; rootClassification === 'unknown' && attempt <= 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt - 1)))
    rootClassification = await classifyOpencodeSession(opencodeSessionId, opencode, cfg)
  }

  // A genuinely new, non-duplicate `idle` completion — check it isn't the SAME
  const runawayCheck = (): void => {
    if (effectiveStatus !== 'idle') return
    void observeIdleForRunaway(opencodeSessionId, turn.parentMessageId, async () => {
      noteOpencodeStopRequested(opencodeSessionId, 'runaway-guard')
      try {
        await fetch(
          `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/abort?directory=${encodeURIComponent(cfg.workspace)}`,
          { method: 'POST', signal: AbortSignal.timeout(10_000) },
        )
      } catch (err) {
        logger.warn('[runaway-turn-guard] abort call failed', { opencodeSessionId, err: (err as Error).message })
      }
    })
  }

  // Only the root turn closes channel output and shortens the idle deadline. A
  if (rootClassification !== 'root') {
    runawayCheck()
    return
  }

  // Exactly-once per completed turn: an idle turn (natural OR reconciled on
  const dedupSig =
    effectiveStatus === 'idle' && turn.completedAt != null
      ? `${opencodeSessionId}:${turn.completedAt}`
      : null
  if (dedupSig && relayedTurnSignatures.has(dedupSig)) {
    logger.info('[opencode-events] turn-end already relayed for this turn; skipping', { opencodeSessionId })
    return
  }

  // Root: past the turn-end dedup, so a duplicate observation of one real
  // reply never reads as a repeat.
  runawayCheck()

  // A credential the API has refused, repeatedly and without contradiction,
  if (sessionTokenPresumedDead()) return

  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  // This is the ONLY signal that finalizes a turn the agent ended without
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          session_id: sessionId,
          kind: 'end',
          status: effectiveStatus,
          opencode_session_id: opencodeSessionId,
          turn_message_id: turn.parentMessageId ?? undefined,
          ...(error
            ? {
                error_name: error.name,
                error_message: error.message,
                error_status: error.statusCode,
                error_retryable: error.isRetryable,
                error_provider: error.providerID,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean
          turn_completion?: { outcome?: string; active_turn_count?: number }
          queue_promoted?: boolean
          promoted_prompt_id?: string | null
        } | null
        const outcome = data?.turn_completion?.outcome
        const accepted =
          outcome === undefined ||
          outcome === 'closed' ||
          outcome === 'already_closed' ||
          outcome === 'no_active_turn'
        if (!accepted) {
          logger.warn('[opencode-events] turn-end relay was not settled', {
            outcome: outcome ?? 'unknown',
            opencodeSessionId,
            turnMessageId: turn.parentMessageId,
            activeTurnCount: data?.turn_completion?.active_turn_count,
            queuePromoted: data?.queue_promoted,
            promotedPromptId: data?.promoted_prompt_id,
            attempt,
          })
          if (attempt < 4) {
            const reread = await readRootTurnState(opencodeSessionId, opencode, cfg)
            if (turn.completedAt == null || reread.completedAt === turn.completedAt) {
              turn = reread
              error = eventError ?? turn.error
              effectiveStatus = error ? 'error' : status
            }
            await new Promise((r) => setTimeout(r, 1_000 * attempt))
          }
          continue
        }
        // Record the dedup signature ONLY on a confirmed relay — a res.ok is a
        // definitive answer from apps/api (relayed, or already-finalized), so a
        // later observation of the same completed turn is a safe no-op to skip.
        if (dedupSig) relayedTurnSignatures.add(dedupSig)
        if (data?.ok) logger.info('[opencode-events] turn end relayed', { status: effectiveStatus, errorName: error?.name, opencodeSessionId, attempt })
        return
      }
      const bodyText = await res.text().catch(() => '')
      noteControlPlaneResponse(res.status, bodyText)
      logger.warn('[opencode-events] turn-end relay non-ok', {
        status: res.status,
        attempt,
        body: bodyText.slice(0, 200),
      })
    } catch (err) {
      logger.warn('[opencode-events] turn-end relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 1_000 * attempt))
  }
  logger.error('[opencode-events] turn-end relay gave up after retries', { sessionId, status: effectiveStatus })
}

/** Settle an orphan by its own message identity even when OpenCode never stamped completion. */
export async function relayOrphanedTurnEndToApi(opencodeSessionId: string, turnMessageId: string): Promise<void> {
  const dedupSig = `orphan:${opencodeSessionId}:${turnMessageId}`
  if (relayedTurnSignatures.has(dedupSig)) return
  const relayed = await relayTurnEnd({
    runtimeSessionId: opencodeSessionId,
    messageId: turnMessageId,
    status: 'error',
    error: {
      name: 'RuntimeAbortedTurn',
      message: 'The agent runtime restarted mid-turn. Send your message again.',
    },
  })
  if (relayed) relayedTurnSignatures.add(dedupSig)
}

interface RootTurnState {
  /** The turn's failure (from the last assistant message), if any. */
  error?: OpencodeTurnError
  /** The last assistant message's completion time — the turn's completed
   *  identity, used as the exactly-once dedup key. null while the turn is still
   *  running (assistant message present but not completed) or before any reply. */
  completedAt: number | null
  /** The user message this assistant turn answers. This is the stable identity
   *  minted by the client and recorded by apps/api before prompt delivery. */
  parentMessageId: string | null
}

// Read the ROOT turn's outcome from its last assistant message — the same
async function readRootTurnState(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<RootTurnState> {
  try {
    const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}/message?directory=${encodeURIComponent(cfg.workspace)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return { completedAt: null, parentMessageId: null }
    const rows = (await res.json()) as Array<{
      info?: {
        role?: string
        parentID?: string
        time?: { completed?: number }
        error?: {
          name?: string
          data?: {
            message?: string
            statusCode?: number
            isRetryable?: boolean
            providerID?: string
          }
        }
      }
    }>
    if (!Array.isArray(rows)) return { completedAt: null, parentMessageId: null }
    // The most recent assistant message decides the turn's outcome. Trailing
    let openTurnParentId: string | null | undefined
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (info?.role !== 'assistant') continue
      const open =
        info.time?.completed == null && (!info.error || info.error.data?.isRetryable === true)
      if (open) {
        if (openTurnParentId === undefined) openTurnParentId = info.parentID ?? null
        continue
      }
      const sameTurnAsTheOpenOne =
        openTurnParentId !== undefined &&
        (openTurnParentId === null || info.parentID == null || info.parentID === openTurnParentId)
      if (sameTurnAsTheOpenOne) return { completedAt: null, parentMessageId: null }
      return {
        error: info.error ? flattenOpencodeError(info.error) : undefined,
        completedAt: info.time?.completed ?? null,
        parentMessageId: info.parentID ?? null,
      }
    }
    return { completedAt: null, parentMessageId: null }
  } catch {
    return { completedAt: null, parentMessageId: null }
  }
}

// Reconcile-on-subscribe backstop for the fast-boot event-loss race. When the
export async function reconcileFinishedFirstTurn(
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<void> {
  if (!sandboxRelayContext()) return
  const rootId = readOpenCodeSessionPin()
  if (!rootId) return
  const turn = await readRootTurnState(rootId, opencode, cfg)
  // Only reconcile a turn that has actually completed; a still-running turn will
  // finalize via its own (now-subscribed) session.idle.
  if (turn.completedAt == null) return
  logger.info('[opencode-events] reconciling turn that completed before subscribe', { rootId, completedAt: turn.completedAt })
  await relayTurnEndToApi(rootId, 'idle', opencode, cfg)
}

// Is this opencode session the ROOT turn session (not a subagent child)? A root
export async function isRootOpencodeSession(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<boolean> {
  return (await classifyOpencodeSession(opencodeSessionId, opencode, cfg)) === 'root'
}

async function classifyOpencodeSession(
  opencodeSessionId: string,
  opencode: Pick<Opencode, 'getInternalUrl'>,
  cfg: Config,
): Promise<'root' | 'child' | 'unknown'> {
  try {
    const url = `${opencode.getInternalUrl()}/session/${encodeURIComponent(opencodeSessionId)}?directory=${encodeURIComponent(cfg.workspace)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return 'unknown'
    const session = (await res.json()) as { parentID?: string | null }
    return session.parentID ? 'child' : 'root'
  } catch {
    return 'unknown'
  }
}
