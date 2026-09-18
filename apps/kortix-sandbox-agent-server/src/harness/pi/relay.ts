/**
 * The control-plane callbacks a pi session makes, over the SAME routes and
 * body shapes the OpenCode adapter uses (`POST /projects/:id/turn-stream`,
 * `/turn-question`, `/platform/runtime-projection`). apps/api does not know
 * which harness is calling, and must not have to.
 *
 * Every relay is bounded, never throws into its caller, and no-ops when the
 * daemon has no control-plane config (local / self-host boots).
 */
import { logger } from '../../logger'

interface RelayContext {
  projectId: string
  sessionId: string
  token: string
  apiRoot: string
}

export function relayContext(env: NodeJS.ProcessEnv = process.env): RelayContext | null {
  const projectId = env.KORTIX_PROJECT_ID?.trim()
  const sessionId = env.KORTIX_SESSION_ID?.trim()
  const token = (env.KORTIX_TOKEN || '').trim()
  const apiUrl = env.KORTIX_API_URL?.replace(/\/+$/, '')
  if (!projectId || !sessionId || !token || !apiUrl) return null
  return { projectId, sessionId, token, apiRoot: apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1` }
}

async function postTurnStream(ctx: RelayContext, body: Record<string, unknown>, timeoutMs = 15_000): Promise<Response> {
  return fetch(`${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/turn-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ session_id: ctx.sessionId, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export interface InitialTurnClaim {
  prompt: string
  turnToken: string
  messageId: string
}

let claimedInitialTurn: InitialTurnClaim | null = null
let claimInFlight: Promise<InitialTurnClaim | null> | null = null

export function __resetPiRelaysForTests(): void {
  claimedInitialTurn = null
  claimInFlight = null
  relayedTurnBegins.clear()
  relayedTurnEnds.clear()
  lastPushedProjectionEtag = null
}

/** Claim the pending first turn (memoized: the prefetch and the boot path share one call). */
export function claimInitialTurn(): Promise<InitialTurnClaim | null> {
  if (claimedInitialTurn) return Promise.resolve(claimedInitialTurn)
  if (claimInFlight) return claimInFlight
  claimInFlight = (async () => {
    const ctx = relayContext()
    if (!ctx) return null
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await postTurnStream(ctx, { kind: 'initial_turn_claim' })
        if (!res.ok) {
          if (res.status < 500) throw new Error(`initial turn claim rejected: ${res.status}`)
          lastError = new Error(`initial turn claim returned ${res.status}`)
        } else {
          const body = (await res.json()) as { initial_turn?: { prompt?: unknown; turn_token?: unknown; message_id?: unknown } | null }
          const turn = body.initial_turn
          if (!turn || typeof turn.prompt !== 'string' || typeof turn.turn_token !== 'string' || typeof turn.message_id !== 'string') return null
          claimedInitialTurn = { prompt: turn.prompt, turnToken: turn.turn_token, messageId: turn.message_id }
          return claimedInitialTurn
        }
      } catch (err) {
        lastError = err
        if (err instanceof Error && err.message.startsWith('initial turn claim rejected')) throw err
      }
      if (attempt < 2) await Bun.sleep(250 * 2 ** attempt)
    }
    throw new Error(`initial turn claim failed after 3 attempts: ${String(lastError)}`)
  })().finally(() => {
    claimInFlight = null
  })
  return claimInFlight
}

export async function relayInitialTurnAccepted(rootId: string, messageId: string, turnToken: string): Promise<boolean> {
  const ctx = relayContext()
  if (!ctx) return false
  const res = await postTurnStream(ctx, { kind: 'turn_accepted', opencode_session_id: rootId, turn_message_id: messageId, turn_token: turnToken })
  if (!res.ok) throw new Error(`initial turn acceptance rejected: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true
}

export async function relayInitialTurnAbandoned(turnToken: string): Promise<boolean> {
  const ctx = relayContext()
  if (!ctx) return false
  const res = await postTurnStream(ctx, { kind: 'turn_abandoned', turn_token: turnToken })
  if (!res.ok) throw new Error(`initial turn abandonment rejected: ${res.status}`)
  return ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true
}

/** Set the durable root pin server-side (Slack/trigger sessions never open a browser). */
export async function relayBootstrapPin(rootId: string): Promise<void> {
  const ctx = relayContext()
  if (!ctx) return
  try {
    const res = await postTurnStream(ctx, { kind: 'opencode_session', opencode_session_id: rootId })
    if (!res.ok) logger.warn('[pi] bootstrap pin relay non-ok', { status: res.status })
  } catch (err) {
    logger.warn('[pi] bootstrap pin relay failed', { err: (err as Error).message })
  }
}

const relayedTurnBegins = new Set<string>()

export async function relayTurnBegin(rootId: string, messageId: string): Promise<void> {
  const ctx = relayContext()
  if (!ctx || relayedTurnBegins.has(messageId)) return
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postTurnStream(ctx, { kind: 'turn_begin', opencode_session_id: rootId, turn_message_id: messageId })
      if (res.ok) {
        relayedTurnBegins.add(messageId)
        return
      }
      logger.warn('[pi] turn-begin relay non-ok', { status: res.status, attempt })
    } catch (err) {
      logger.warn('[pi] turn-begin relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 2) await Bun.sleep(1_000)
  }
}

const relayedTurnEnds = new Set<string>()

/**
 * The ONLY signal that finalizes a turn server-side (channel output, the
 * idle deadline). Retried with backoff; a non-ok answer is definitive.
 */
export async function relayTurnEnd(
  rootId: string,
  messageId: string,
  status: 'idle' | 'error',
  error?: { name: string; message?: string },
): Promise<void> {
  const ctx = relayContext()
  if (!ctx || relayedTurnEnds.has(messageId)) return
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await postTurnStream(ctx, {
        kind: 'end',
        status,
        opencode_session_id: rootId,
        turn_message_id: messageId,
        ...(error ? { error_name: error.name, error_message: error.message } : {}),
      })
      if (res.ok) {
        relayedTurnEnds.add(messageId)
        logger.info('[pi] turn end relayed', { status, messageId, attempt })
        return
      }
      logger.warn('[pi] turn-end relay non-ok', { status: res.status, attempt })
    } catch (err) {
      logger.warn('[pi] turn-end relay fetch failed', { err: (err as Error).message, attempt })
    }
    if (attempt < 4) await Bun.sleep(1_000 * attempt)
  }
  logger.error('[pi] turn-end relay gave up after retries', { messageId, status })
}

/**
 * Persist an asked question server-side so it survives the box being parked.
 * A channel (Slack) session cannot answer in-band: the question tool is
 * released with the same sentinel OpenCode's relay uses, and the reply
 * arrives as a new turn.
 */
export async function relayQuestion(
  request: { id: string; sessionID: string; questions: unknown[] },
  answer: (answers: string[][]) => void,
): Promise<void> {
  const ctx = relayContext()
  if (!ctx) return
  try {
    await fetch(`${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/turn-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ session_id: ctx.sessionId, request_id: request.id, opencode_session_id: request.sessionID, questions: request.questions }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    logger.warn('[pi] turn-question post failed (non-fatal)', { err: (err as Error).message })
  }
  if (!(process.env.SLACK_THREAD_TS || process.env.SLACK_CHANNEL_ID)) return
  const sentinel =
    '(Posted to the Slack thread. In Slack, questions are async — the user replies ' +
    'as a normal message, which reaches you as a NEW turn with full context. Do NOT ' +
    'wait for an answer here; finish this turn now. Next time, just ask with ' +
    '`slack send` rather than the question tool.)'
  answer(request.questions.map(() => [sentinel]))
}

let projectionTimer: ReturnType<typeof setTimeout> | null = null
let lastPushedProjectionEtag: string | null = null

/** Debounced, etag-gated push of the state document (gzip, same route as OpenCode's relay). */
export function schedulePiProjectionPush(read: () => { doc: Record<string, unknown>; etag: string } | null, reason: string): void {
  const ctx = relayContext()
  if (!ctx) return
  if (projectionTimer) clearTimeout(projectionTimer)
  const debounce = Number.parseInt(process.env.KORTIX_PROJECTION_RELAY_DEBOUNCE_MS || '', 10)
  projectionTimer = setTimeout(
    () => {
      projectionTimer = null
      void (async () => {
        const state = read()
        if (!state || state.etag === lastPushedProjectionEtag) return
        try {
          const res = await fetch(`${ctx.apiRoot}/platform/runtime-projection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${ctx.token}` },
            body: Bun.gzipSync(
              Buffer.from(
                JSON.stringify({
                  session_id: ctx.sessionId,
                  captured_at: state.doc.built_at,
                  projection_etag: state.etag,
                  projection: state.doc,
                }),
              ),
            ),
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) {
            logger.warn('[pi] projection push non-ok', { status: res.status, reason })
            return
          }
          lastPushedProjectionEtag = state.etag
          logger.info('[pi] projection relayed to api', { reason, etag: state.etag })
        } catch (err) {
          logger.warn('[pi] projection push failed', { err: (err as Error).message })
        }
      })()
    },
    Number.isFinite(debounce) && debounce >= 0 ? debounce : 2_000,
  )
  ;(projectionTimer as { unref?: () => void }).unref?.()
}
