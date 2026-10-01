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
// turn to apps/api. The API finalizes channel output and shortens the sandbox
// deadline to the configured idle grace. OpenCode emits these events for every
// session, including Task-tool children, so only root events can relay.
// Turn-end dedup: the last (opencodeSessionId, turnSignature) we already relayed.
// The signature is the completed turn's identity (last assistant message's
// completed timestamp), so a turn is finalized EXACTLY ONCE no matter which path
// observes it — the natural session.idle, the reconcile-on-subscribe backstop, or
// a duplicate idle from opencode. A genuinely NEW turn has a new completed
// timestamp → a fresh signature → it relays normally. session.error is never
// deduped here (it carries no completed signature and the API's claimFinalize is
// the single-winner backstop). Cleared implicitly by moving to a new signature.
const relayedTurnSignatures = new Set<string>()

/** Test-only: clear the per-turn dedup set between cases. */
export function __resetRelayedTurnSignatures(): void {
  relayedTurnSignatures.clear()
}

// Turn-begin relay dedup: root id -> the newest user message id already
// relayed (or refused as already-known by apps/api). A turn's identity is its
// user message, so one turn relays once no matter how many `busy`/`retry`
// status frames it emits. Per-process, like `relayedTurnSignatures`.
const relayedTurnBegins = new Map<string, string>()
const turnBeginRelaysInFlight = new Set<string>()

/** Test-only: clear the per-turn begin dedup between cases. */
export function __resetRelayedTurnBegins(): void {
  relayedTurnBegins.clear()
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
    if (relayedTurnBegins.get(opencodeSessionId) === newestUserId) return

    const { projectId, sessionId, token, apiRoot } = ctx
    const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
    const payload = JSON.stringify({
      session_id: sessionId,
      kind: 'turn_begin',
      opencode_session_id: opencodeSessionId,
      turn_message_id: newestUserId,
    })
    // A credential the API has refused, repeatedly and without contradiction,
    // cannot accept this relay: both attempts carry the same dead token, and
    // every `busy`/`retry` frame would re-issue them — the `POST .../turn-stream
    // -> 401` warn spike in KRTX-446. Skip while the shared breaker reports the
    // credential dead; it clears on the next answer that is not the dead-token
    // 401, so this resumes by itself and never stops the daemon.
    if (sessionTokenPresumedDead()) return
    // Two attempts only: `busy`/`retry` frames recur for a live turn, so a
    // transient failure retries itself on the next frame.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: payload,
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          // ANY definitive answer dedups: adopted, already-open, or
          // already-known all mean this exact message needs no further relay.
          relayedTurnBegins.set(opencodeSessionId, newestUserId)
          const data = (await res.json().catch(() => null)) as { outcome?: string } | null
          if (data?.outcome === 'adopted') {
            logger.info('[opencode-events] box-initiated turn adopted', {
              opencodeSessionId,
              messageId: newestUserId,
            })
          }
          return
        }
        const bodyText = await res.text().catch(() => '')
        noteControlPlaneResponse(res.status, bodyText)
        logger.warn('[opencode-events] turn-begin relay non-ok', {
          status: res.status,
          attempt,
          body: bodyText.slice(0, 200),
        })
      } catch (err) {
        logger.warn('[opencode-events] turn-begin relay fetch failed', {
          err: (err as Error).message,
          attempt,
        })
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1_000))
    }
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
  // already hands us the error; an idle end (e.g. retries exhausted, then idle)
  // carries none, so read the session's last assistant message — exactly what
  // the web UI shows — and upgrade idle→error when it failed. This is what turns
  // a blank "ended without a reply" in Slack into "out of credits" / rate-limit /
  // the real error. The completed timestamp doubles as the per-turn dedup key.
  //
  // Read BEFORE the root filter, because the runaway guard below must see EVERY
  // session's completions: the 2026-08-18 incident was a CHILD session
  // re-answering the same standing prompt indefinitely, and with the guard
  // placed after the root filter it never saw a single one of those repeats.
  let turn = await readRootTurnState(opencodeSessionId, opencode, cfg)
  let error = eventError ?? turn.error
  let effectiveStatus = error ? 'error' : status
  let rootClassification = await classifyOpencodeSession(opencodeSessionId, opencode, cfg)
  for (let attempt = 2; rootClassification === 'unknown' && attempt <= 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt - 1)))
    rootClassification = await classifyOpencodeSession(opencodeSessionId, opencode, cfg)
  }

  // A genuinely new, non-duplicate `idle` completion — check it isn't the SAME
  // standing prompt answering itself again with no new user message in between
  // (see `runaway-turn-guard.ts`). Per opencode session id, ROOT AND CHILDREN:
  // the abort targets the session that is looping. Scoped to `idle` only: an
  // `error` completion repeating is `turn-auto-resume.ts`'s concern.
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
  // subagent can become idle while the root turn still runs. Detect the root by
  // parentID, not by a session pin that can change after an OpenCode restart.
  // A child's completion is still guarded above — but a child has no per-turn
  // relay dedup signature of its own, so it steps the guard on every idle it
  // reports. Under a real loop those are distinct completions; a duplicate
  // observation of one child completion costs at most one extra tolerated
  // repeat (MAX_CONSECUTIVE_REPEATS absorbs it), never a false abort of a
  // healthy child.
  if (rootClassification !== 'root') {
    runawayCheck()
    return
  }

  // Exactly-once per completed turn: an idle turn (natural OR reconciled on
  // subscribe) relays a single time. The signature is only RECORDED after a
  // confirmed relay (below), so a transient API outage that fails all retries
  // never permanently suppresses the reconcile backstop — a later observation of
  // the same turn can still relay it. Errors have no completed signature, so they
  // always pass through and rely on the API's single-winner claimFinalize.
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
  // cannot finalize a turn: all four attempts carry the same dead token. Skip
  // the API relay (the local runaway guard above has already run) so a box that
  // outlives its session stops adding `POST .../turn-stream -> 401` warn lines
  // (KRTX-446). The dedup signature is recorded only on a confirmed relay, so a
  // later observation still relays once the credential works again — the breaker
  // clears on the next non-dead answer, and the daemon keeps serving.
  if (sessionTokenPresumedDead()) return

  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  // This is the ONLY signal that finalizes a turn the agent ended without
  // `slack send` (otherwise the ⏳ lingers until the 30-min GC). It must not be
  // best-effort: retry with backoff before giving up. A non-ok HTTP response is
  // a definitive answer from apps/api (e.g. already finalized), so we stop on any
  // `res.ok`; only network/5xx failures are retried.
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
// `AssistantMessage.error` the web UI renders — plus its completion timestamp.
// opencode's session.error event already carries the error for a hard failure,
// but a run that exhausts retries (e.g. out of credits / rate-limited) can end on
// `session.idle` with the error only on the message; this is what lets Slack still
// say *why* instead of going silent. The `completedAt` is the per-turn dedup key
// so a turn finalizes exactly once regardless of which path observes its end.
// Best-effort: any miss/parse failure returns a clean, un-completed state, so this
// never turns a healthy turn into a phantom failure.
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
    // USER rows are SKIPPED, not a boundary: a prompt forwarded into a live
    // turn — and OpenCode's own synthetic `<pty_exited>` wake-ups — leave a
    // user message as the newest row at almost every turn end, and bailing
    // there unnamed EVERY relay for such sessions (live 2026-08-20:
    // `relay_named:false` on each end, double finalizes
    // because the unnamed relay has no dedup signature, and the forwarded-turn
    // reconciler lost its primary key). Attribution is message-scoped — the
    // assistant's own `parentID` names the turn it answered — so a pending
    // follow-up prompt can never be blamed for a prior turn's error.
    //
    // A newest assistant that is still OPEN (no completion, no terminal error)
    // is not automatically a dead end either. WHICH TURN it belongs to decides,
    // and `parentID` says so — the same linkage the API-side husk finalizer
    // matches on. Two different shapes hide behind one open row:
    //
    //   `[uA, aA1(done), aA2(open)]`   one turn, mid-step  → STAY UNNAMED.
    //       Naming aA1 would let completeSandboxTurn close a row whose turn is
    //       still streaming.
    //   `[uA, aA(done), uB, aB(open)]` turn A ended, B races → NAME A.
    //       The idle being handled cannot be B's (B is open), so A is the turn
    //       that ended. The old code stopped at the open row and relayed A with
    //       no `turn_message_id` and no dedup signature — the ledger row then
    //       never closed by message and waited for a reaper sweep, which is a
    //       direct "stuck working forever" contributor.
    //
    // An open row whose `parentID` is missing proves nothing about which turn
    // is running, so it keeps the old conservative unnamed answer.
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
// /event SSE connects, the FIRST turn may have already reached session.idle in
// the prompt→subscribe gap (a fast boot + a trivial prompt), so the idle event
// was fired before anyone was listening and is gone. Read the pinned root's
// last-turn state directly: if it has already COMPLETED (an assistant message
// with a completion time), relay a synthetic turn-end so the turn finalizes even
// though its live event was missed. relayTurnEndToApi dedups by the completed
// signature, so if the natural idle WASN'T dropped this is a no-op. The callback
// works for all project sessions and remains a no-op without sandbox identity.
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
// has no parentID; Task-tool children do. We ask opencode directly rather than
// comparing against the boot-pinned id: an opencode restart can mint a NEW root
// and orphan the old pin, and gating turn-end on pin-equality then filters out
// the REAL turn's `session.idle` — the Slack message then loads forever. parentID
// is the objective signal that survives a re-pin. On any uncertainty, return
// false so we never close the stream prematurely — the GC sweep is the backstop.
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
