/**
 * The daemon's turn callbacks to apps/api, for every harness (E12):
 * `POST /projects/:id/turn-stream`, `/turn-question` and `/turn-permission`.
 *
 * An adapter decides WHEN a turn begins or ends and WHAT its identity is; this
 * module owns the route, the body (`@kortix/api-contract/runtime-relay`), the
 * credential, the retries and the dead-token breaker. A callback added here
 * reaches every harness.
 *
 * Every relay is bounded and no-ops when the daemon has no control-plane
 * config (local and self-host boots). Only the initial-turn calls throw: boot
 * decides what a failed claim or acceptance means.
 */
import type {
  DaemonTurnStreamKind,
  TurnPermissionRelayBody,
  TurnQuestionRelayBody,
  TurnStreamRelayBody,
} from '@kortix/api-contract/runtime-relay'
import type { RuntimePermissionRequest, RuntimeQuestionRequest, TurnErrorCode } from '@kortix/api-contract/transcript'
import { logger } from '@/lib/log/logger'
import { sandboxRelayContext, sessionChannel } from '@/lib/kortix-api/relay-context'
import { noteControlPlaneResponse, sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import type { InitialTurnClaim } from '@/types/control-plane'

export type TurnStreamFrame = Omit<TurnStreamRelayBody, 'session_id' | 'kind'> & { kind: DaemonTurnStreamKind }

/** One POST, or null when this box has no control plane. */
export async function postTurnStream(frame: TurnStreamFrame, timeoutMs = 15_000): Promise<Response | null> {
  const ctx = sandboxRelayContext()
  if (!ctx) return null
  const body: TurnStreamRelayBody = { session_id: ctx.sessionId, ...frame }
  return fetch(`${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/turn-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

// ── The first turn ────────────────────────────────────────────────────────

let claimedInitialTurn: InitialTurnClaim | null = null
let claimedRootPin: string | null = null
let claimInFlight: Promise<InitialTurnClaim | null> | null = null

/** The first turn this process claimed, once `claimInitialTurn` resolved one. */
export function initialTurnClaim(): InitialTurnClaim | null {
  return claimedInitialTurn
}

/**
 * The runtime root the control plane has pinned for this session, as the
 * initial-turn claim reported it. Null before the claim, when no root is
 * pinned, or from an API that predates the field.
 */
export function claimedRuntimeSessionPin(): string | null {
  return claimedRootPin
}

/** Test seam: a daemon process claims at most one initial turn. */
export function resetInitialTurnClaimForTests(): void {
  claimedInitialTurn = null
  claimedRootPin = null
  claimInFlight = null
}

/**
 * Claim the pending first turn through the session-bound credential. Memoized:
 * the boot prefetch and the boot path share one call. 3 attempts on a network
 * failure or a 5xx; a 4xx is definitive and throws.
 */
export function claimInitialTurn(): Promise<InitialTurnClaim | null> {
  if (claimedInitialTurn) return Promise.resolve(claimedInitialTurn)
  if (claimInFlight) return claimInFlight
  claimInFlight = (async () => {
    if (!sandboxRelayContext()) return null
    let response: Response | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await postTurnStream({ kind: 'initial_turn_claim' })
        if (!response || response.ok || response.status < 500) break
        lastError = new Error(`initial turn claim returned ${response.status}`)
      } catch (error) {
        lastError = error
      }
      if (attempt < 2) await Bun.sleep(250 * 2 ** attempt)
    }
    if (!response) throw new Error(`initial turn claim failed after 3 attempts: ${String(lastError)}`)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`initial turn claim rejected: ${response.status} ${text.slice(0, 200)}`)
    }
    const body = (await response.json()) as {
      initial_turn?: { prompt?: unknown; turn_token?: unknown; message_id?: unknown } | null
      runtime_session_id?: unknown
    }
    const pin = typeof body.runtime_session_id === 'string' ? body.runtime_session_id.trim() : ''
    claimedRootPin = pin || null
    const turn = body.initial_turn
    if (!turn || typeof turn.prompt !== 'string' || typeof turn.turn_token !== 'string' || typeof turn.message_id !== 'string') {
      return null
    }
    claimedInitialTurn = { prompt: turn.prompt, turnToken: turn.turn_token, messageId: turn.message_id }
    return claimedInitialTurn
  })().finally(() => {
    claimInFlight = null
  })
  return claimInFlight
}

/**
 * Promote the initial-turn authority apps/api created before the sandbox
 * existed, once the runtime accepted the exact message. The daemon cannot mint
 * a token or revive a record terminal evidence removed.
 */
export async function relayTurnAccepted(runtimeSessionId: string, messageId: string, turnToken: string): Promise<boolean> {
  const response = await postTurnStream({
    kind: 'turn_accepted',
    runtime_session_id: runtimeSessionId,
    turn_message_id: messageId,
    turn_token: turnToken,
  })
  if (!response) throw new Error('initial turn acceptance relay context is unavailable')
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`initial turn acceptance rejected: ${response.status} ${text.slice(0, 200)}`)
  }
  return ((await response.json().catch(() => ({}))) as { ok?: boolean }).ok === true
}

/** Remove only a pre-created initial-turn record the runtime never accepted. */
export async function relayTurnAbandoned(turnToken: string): Promise<boolean> {
  const response = await postTurnStream({ kind: 'turn_abandoned', turn_token: turnToken })
  if (!response) throw new Error('initial turn abandonment relay context is unavailable')
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`initial turn abandonment rejected: ${response.status} ${text.slice(0, 200)}`)
  }
  return ((await response.json().catch(() => ({}))) as { ok?: boolean }).ok === true
}

/**
 * Report the session's root so apps/api writes the durable pin at bootstrap,
 * with no browser open (Slack and trigger sessions). Best-effort, never blocks
 * boot: the API also heals the pin later.
 */
export async function relayRuntimeSession(runtimeSessionId: string): Promise<void> {
  try {
    const response = await postTurnStream({ kind: 'runtime_session', runtime_session_id: runtimeSessionId })
    if (!response) return
    if (!response.ok) {
      logger.warn('[turn-relay] bootstrap pin relay non-ok', { status: response.status })
      return
    }
    logger.info('[turn-relay] bootstrap root pinned via api', { runtimeSessionId })
  } catch (err) {
    logger.warn('[turn-relay] bootstrap pin relay failed', { err: (err as Error).message })
  }
}

// ── Turn begin and end ────────────────────────────────────────────────────

// Root id -> the newest user message already relayed (or refused as known).
// A turn's identity is its user message, so one turn relays once however many
// status frames announce it.
const relayedTurnBegins = new Map<string, string>()

/** Test seam: clear the per-turn begin dedup. */
export function resetTurnBeginRelaysForTests(): void {
  relayedTurnBegins.clear()
}

/**
 * Announce a turn the box started (`turn_begin`). apps/api adopts it only when
 * no open turn exists and the message is new, so relaying a delivered prompt is
 * a cheap no-op. 2 attempts: a live turn re-announces itself on its next status
 * frame. Skipped while the session credential is presumed dead (KRTX-446).
 */
export async function relayTurnBegin(runtimeSessionId: string, messageId: string): Promise<void> {
  if (!sandboxRelayContext() || relayedTurnBegins.get(runtimeSessionId) === messageId) return
  if (sessionTokenPresumedDead()) return
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await postTurnStream({ kind: 'turn_begin', runtime_session_id: runtimeSessionId, turn_message_id: messageId })
      if (!response) return
      if (response.ok) {
        // ANY definitive answer dedups: adopted, already open, or already known.
        relayedTurnBegins.set(runtimeSessionId, messageId)
        const data = (await response.json().catch(() => null)) as { outcome?: string } | null
        if (data?.outcome === 'adopted') logger.info('[turn-relay] box-initiated turn adopted', { runtimeSessionId, messageId })
        return
      }
      const text = await response.text().catch(() => '')
      noteControlPlaneResponse(response.status, text)
      logger.warn('[turn-relay] turn-begin relay non-ok', { status: response.status, attempt, body: text.slice(0, 200) })
    } catch (err) {
      logger.warn('[turn-relay] turn-begin relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 2) await Bun.sleep(1_000)
  }
}

/**
 * The running turn read a steered message at a step boundary (`steer_read`).
 * apps/api closes that message's inbox row as delivered. 3 attempts; a
 * non-ok answer other than 5xx is definitive. Skipped while the session
 * credential is presumed dead (KRTX-446).
 */
export async function relaySteerRead(runtimeSessionId: string, messageId: string): Promise<void> {
  if (!sandboxRelayContext() || sessionTokenPresumedDead()) return
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await postTurnStream({ kind: 'steer_read', runtime_session_id: runtimeSessionId, turn_message_id: messageId })
      if (!response || response.ok) return
      const text = await response.text().catch(() => '')
      noteControlPlaneResponse(response.status, text)
      logger.warn('[turn-relay] steer-read relay non-ok', { status: response.status, attempt, body: text.slice(0, 200) })
      if (response.status < 500) return
    } catch (err) {
      logger.warn('[turn-relay] steer-read relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 3) await Bun.sleep(1_000 * attempt)
  }
}

/** A turn's end, as the adapter observed it. */
export interface TurnEndFrame {
  runtimeSessionId: string
  /** The user message the turn answers. Unnamed, apps/api cannot close the turn. */
  messageId: string | null
  status: 'idle' | 'error'
  error?: {
    name?: string
    message?: string
    statusCode?: number
    isRetryable?: boolean
    providerID?: string
    /** Set by an adapter that knows better than `turnErrorCode` (pi's context overflow). */
    code?: TurnErrorCode
  }
}

/**
 * Why a turn failed, from a message error's name and HTTP status. `unknown`
 * covers every other failure, including an abort nobody asked for
 * (`RuntimeAbortedTurn`) and a timeout.
 */
export function turnErrorCode(error: { name?: string; statusCode?: number }): TurnErrorCode {
  switch (error.name) {
    case 'ProviderAuthError':
      return 'auth'
    case 'MessageAbortedError':
      return 'aborted'
    case 'ContextOverflowError':
      return 'context_length'
    case 'MessageOutputLengthError':
      return 'output_length'
  }
  if (error.statusCode === 401 || error.statusCode === 403) return 'auth'
  if (error.statusCode === 402) return 'credits'
  if (error.statusCode === 429) return 'rate_limit'
  return 'unknown'
}

function turnEndBody(frame: TurnEndFrame): TurnStreamFrame {
  const { error } = frame
  return {
    kind: 'end',
    status: frame.status,
    runtime_session_id: frame.runtimeSessionId,
    turn_message_id: frame.messageId ?? undefined,
    ...(error
      ? {
          error_name: error.name,
          error_message: error.message,
          error_status: error.statusCode,
          error_retryable: error.isRetryable,
          error_provider: error.providerID,
          error_code: error.code ?? turnErrorCode(error),
        }
      : {}),
  }
}

/**
 * The ONLY signal that finalizes a turn server-side: channel output and the
 * idle deadline. 4 attempts with a linear backoff. An answer apps/api did not
 * settle (`turn_completion.outcome` other than closed, already closed or no
 * active turn) retries too, after `reread` re-observes the turn; a settled
 * answer or a non-ok status is definitive. Resolves true only when settled.
 */
export async function relayTurnEnd(
  frame: TurnEndFrame,
  options: { reread?: () => Promise<TurnEndFrame | null> } = {},
): Promise<boolean> {
  if (!sandboxRelayContext()) return false
  // A credential the API refused, repeatedly and without contradiction, cannot
  // finalize a turn: all four attempts carry the same dead token (KRTX-446).
  if (sessionTokenPresumedDead()) return false
  let current = frame
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await postTurnStream(turnEndBody(current))
      if (!response) return false
      if (response.ok) {
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean
          turn_completion?: { outcome?: string; active_turn_count?: number }
          queue_promoted?: boolean
          promoted_prompt_id?: string | null
        } | null
        const outcome = data?.turn_completion?.outcome
        const settled = outcome === undefined || outcome === 'closed' || outcome === 'already_closed' || outcome === 'no_active_turn'
        if (settled) {
          if (data?.ok) logger.info('[turn-relay] turn end relayed', { status: current.status, errorName: current.error?.name, runtimeSessionId: current.runtimeSessionId, attempt })
          return true
        }
        logger.warn('[turn-relay] turn-end relay was not settled', {
          outcome: outcome ?? 'unknown',
          runtimeSessionId: current.runtimeSessionId,
          turnMessageId: current.messageId,
          activeTurnCount: data?.turn_completion?.active_turn_count,
          queuePromoted: data?.queue_promoted,
          promotedPromptId: data?.promoted_prompt_id,
          attempt,
        })
        if (attempt < 4) {
          current = (await options.reread?.().catch(() => null)) ?? current
          await Bun.sleep(1_000 * attempt)
        }
        continue
      }
      const text = await response.text().catch(() => '')
      noteControlPlaneResponse(response.status, text)
      logger.warn('[turn-relay] turn-end relay non-ok', { status: response.status, attempt, body: text.slice(0, 200) })
    } catch (err) {
      logger.warn('[turn-relay] turn-end relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 4) await Bun.sleep(1_000 * attempt)
  }
  logger.error('[turn-relay] turn-end relay gave up after retries', { runtimeSessionId: frame.runtimeSessionId, status: frame.status })
  return false
}

/**
 * Report a memory-guard abort as the turn's end, so the ledger records
 * `failed` with a reason that names memory. apps/api closes a turn only when
 * the frame names it; the turn is named only when the abort landed, because a
 * failed abort leaves it running.
 */
export async function relayMemoryGuardTurnEnd(input: {
  reason: string
  aborted: boolean
  runtimeRssMb: number | null
  runtimeSessionId: string | null
  /** The turn that was running when the guard fired, read before the abort. */
  turnMessageId: string | null
}): Promise<boolean> {
  const turnMessageId = input.aborted ? input.turnMessageId : null
  try {
    const response = await postTurnStream(
      {
        kind: 'end',
        status: 'error',
        runtime_session_id: input.runtimeSessionId ?? undefined,
        turn_message_id: turnMessageId ?? undefined,
        error_name: 'SandboxMemoryGuard',
        error_message: input.reason,
        error_code: 'unknown',
        // An aborted turn is over. apps/api reads `true` as "a retry, still
        // running" and drops the frame as `non_terminal`; that is the truth
        // only when the abort did not land.
        error_retryable: !input.aborted,
      },
      10_000,
    )
    if (!response) return false
    logger.warn('[resources] memory guard relayed to the control plane', {
      status: response.status,
      turnMessageId,
      aborted: input.aborted,
      runtimeRssMb: input.runtimeRssMb,
    })
    return response.ok
  } catch (err) {
    logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    return false
  }
}

// ── Interactions ──────────────────────────────────────────────────────────

/**
 * Persist an asked question server-side, so it survives the box being parked.
 * Best-effort. Returns the answer that releases the blocking question tool in a
 * channel session (Slack, Teams), where the reply arrives as a NEW turn; null
 * in a web session, where the question stays open for the UI. The adapter
 * delivers that answer to its runtime.
 */
export async function relayQuestion(request: Pick<RuntimeQuestionRequest, 'id' | 'sessionID' | 'questions'>): Promise<string[][] | null> {
  const ctx = sandboxRelayContext()
  if (!ctx) return null
  logger.info('[turn-relay] relaying an asked question', { requestId: request.id, questions: request.questions.length })
  const body: TurnQuestionRelayBody = {
    session_id: ctx.sessionId,
    request_id: request.id,
    runtime_session_id: request.sessionID,
    questions: request.questions,
  }
  try {
    await fetch(`${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/turn-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    logger.warn('[turn-relay] turn-question post failed (non-fatal)', { err: (err as Error).message })
  }
  // apps/api releases channel questions itself inside /turn-question; this is
  // the fallback when that fails. A release that loses the race is a harmless
  // 404 in the runtime.
  const channel = sessionChannel()
  if (!channel) return null
  // Name the channel the agent is in: a Teams agent has no `slack send`.
  const sentinel =
    `(Posted to the ${channel} conversation. In ${channel}, questions are async — the user ` +
    'replies as a normal message, which reaches you as a NEW turn with full context. Do NOT ' +
    'wait for an answer here; finish this turn now.)'
  return request.questions.map(() => [sentinel])
}

/**
 * Report a permission request, so apps/api sends the session creator a "needs
 * your approval" push. REPORT ONLY: the request stays open until the user
 * answers it in the session UI. `metadata` is not sent (an edit carries its
 * full diff, and the push does not use it). apps/api dedupes a repeated id.
 */
export async function relayPermission(request: Pick<RuntimePermissionRequest, 'id' | 'sessionID' | 'permission' | 'patterns'>): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  logger.info('[turn-relay] relaying a permission request', { requestId: request.id, permission: request.permission })
  const body: TurnPermissionRelayBody = {
    session_id: ctx.sessionId,
    request_id: request.id,
    runtime_session_id: request.sessionID,
    permission: request.permission,
    patterns: Array.isArray(request.patterns) ? request.patterns : [],
  }
  try {
    const response = await fetch(`${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/turn-permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) logger.warn('[turn-relay] turn-permission post non-ok (non-fatal)', { status: response.status })
  } catch (err) {
    logger.warn('[turn-relay] turn-permission post failed (non-fatal)', { err: (err as Error).message })
  }
}
