import { readFileSync } from 'node:fs'

import { logger } from './logger'
import { OPENCODE_SESSION_PIN_PATH } from './runtime-state'
export { OPENCODE_SESSION_PIN_PATH } from './runtime-state'

/**
 * Is opencode mid-turn, and did a turn get orphaned?
 *
 * Both questions have the same answer source — the root's last message — and two
 * callers that must not drift: the post-respawn cleanup (which aborts a turn
 * whose process died) and the reload gate (which refuses to restart opencode out
 * from under a turn that is still running).
 *
 * "In flight" is `last message is an assistant message with no completion time`.
 * That is the same test boot has always used to decide whether an adopted root
 * needs its turn finalized; it is true both for a turn that is genuinely running
 * and for one whose writer died. Distinguishing them is the caller's job:
 * post-respawn, the writer is by definition gone.
 */
/**
 * The canonical opencode root, or null when nothing is pinned yet.
 *
 * The value goes into a URL, so it is shape-checked rather than trusted: the pin
 * file is daemon-written and 0600, but "a file decides part of an outbound
 * request" is worth closing off regardless of who writes it today. opencode ids
 * are `ses_` + base-ish chars; anything else is treated as no pin at all.
 */
const OPENCODE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export function readPinnedSessionId(): string | null {
  try {
    const id = readFileSync(OPENCODE_SESSION_PIN_PATH, 'utf8').trim()
    if (!OPENCODE_SESSION_ID.test(id)) {
      if (id.length > 0) logger.warn('[turn-state] ignoring a malformed pinned session id')
      return null
    }
    return id
  } catch {
    return null
  }
}

export interface RootInspection {
  /** The root has messages — a prompt was delivered. */
  hasMessages: boolean
  /** Its last message is an assistant turn with no completion time. */
  lastTurnIncomplete: boolean
  /**
   * The root's LAST message is a user prompt opencode never answered.
   *
   * A respawned opencode keeps the PERSISTED user message and loses the
   * in-memory queue, so this state means "a prompt was dropped", not "a turn is
   * running". It used to be reported as `turnInFlight`, which renewed the
   * control plane's turn grant on every reaper pass — for ever. That is the
   * phantom-busy this field ends: the control plane can now read it as an
   * ending (`abandoned`) and redeliver the prompt from the inbox.
   */
  orphanedPrompt: boolean
  /** An incomplete assistant turn still owns runtime. */
  turnInFlight: boolean
  /**
   * False when the read failed — opencode unreachable, non-2xx, unparseable.
   *
   * Without this the two "no turn here" answers are indistinguishable: a session
   * genuinely idle, and one we could not ask about. The post-respawn cleanup can
   * treat them the same (nothing to abort either way); the reload gate CANNOT,
   * because "could not tell" must not read as permission to restart.
   */
  known: boolean
}

export async function inspectOpencodeRoot(
  baseUrl: string,
  workspace: string,
  sessionId: string,
): Promise<RootInspection> {
  const unknown = {
    hasMessages: false,
    lastTurnIncomplete: false,
    orphanedPrompt: false,
    turnInFlight: false,
    known: false,
  }
  try {
    const res = await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!res.ok) return unknown
    const msgs = (await res.json()) as Array<{
      info?: {
        role?: string
        time?: { completed?: number }
        error?: { data?: { isRetryable?: boolean } }
      }
    }>
    if (!Array.isArray(msgs) || msgs.length === 0)
      return {
        hasMessages: false,
        lastTurnIncomplete: false,
        orphanedPrompt: false,
        turnInFlight: false,
        known: true,
      }
    const last = msgs[msgs.length - 1]
    const lastTurnIncomplete = Boolean(
      last?.info?.role === 'assistant' &&
        !last?.info?.time?.completed &&
        (!last?.info?.error || last.info.error.data?.isRetryable === true),
    )
    return {
      hasMessages: true,
      lastTurnIncomplete,
      orphanedPrompt: last?.info?.role === 'user',
      // A trailing user message is deliberately NOT counted here any more —
      // see `orphanedPrompt`.
      turnInFlight: lastTurnIncomplete,
      known: true,
    }
  } catch {
    return unknown
  }
}

/**
 * Is a turn running right now? `null` when it cannot be told.
 *
 * The three answers are genuinely different and the caller must see all three.
 * Collapsing "could not tell" into `false` — which this did at first — hands the
 * reload gate a green light while a turn is very much running and opencode is
 * merely slow to answer, defeating the one promise the gate makes. The gate
 * treats `null` as busy; `force` is there for a box that is wedged.
 *
 * No pin IS a definite `false`: nothing has ever run in this sandbox.
 */
export async function opencodeTurnInFlight(
  baseUrl: string,
  workspace: string,
  /** The root to ask about. Defaults to the pinned one; passed explicitly by
   *  tests, which have no pin file. */
  rootSessionId: string | null = readPinnedSessionId(),
): Promise<boolean | null> {
  const sessionId = rootSessionId
  if (!sessionId) return false
  try {
    const inspection = await inspectOpencodeRoot(baseUrl, workspace, sessionId)
    return inspection.known ? inspection.turnInFlight : null
  } catch (err) {
    logger.warn('[turn-state] could not read turn state', { err: (err as Error).message })
    return null
  }
}

/**
 * Is this exact OpenCode session busy or retrying right now? `null` when the
 * status could not be read. Exported for the connect-time turn-begin backstop
 * (main.ts) — see `reconcileRunningTurnOnConnect`.
 */
export async function opencodeSessionInFlight(
  baseUrl: string,
  workspace: string,
  sessionId: string,
): Promise<boolean | null> {
  try {
    const response = await fetch(
      `${baseUrl}/session/status?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!response.ok) return null
    const statuses = (await response.json()) as unknown
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null
    const status = (statuses as Record<string, unknown>)[sessionId]
    if (status === undefined) return false
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null
    const type = (status as { type?: unknown }).type
    if (type === 'busy' || type === 'retry') return true
    if (type === 'idle') return false
    return null
  } catch {
    return null
  }
}

/**
 * HOW one observed turn ended, in the control plane's own vocabulary
 * (`kortix.session_turns.end_reason`).
 *
 * `null` is a real answer, not a gap: the messages prove the turn is over but
 * do not say what ended it. Only values this daemon can PROVE are named.
 */
export type OpencodeTurnEnd = 'completed' | 'failed' | 'abandoned'

export interface OpencodeDeliveryObservation {
  /** Running, over, or `null` when opencode could not be read. */
  inFlight: boolean | null
  /** Set only when `inFlight === false`. */
  end: OpencodeTurnEnd | null
  /** The prompt is on record with nothing answering it — see
   *  {@link RootInspection.orphanedPrompt}. Diagnostic: the control plane acts
   *  on `end`, and reads this to tell a dropped prompt from a quiet one. */
  orphanedPrompt?: boolean
}

/**
 * Observe one client-minted OpenCode user message for lifecycle recovery.
 *
 * A matching user message is active only when it is the newest user message and
 * OpenCode reports the exact root session as busy or retrying. Message
 * persistence alone is not execution evidence. A successful list that lacks
 * the exact message is terminal: the reaper calls this only after the full
 * delivery grace has elapsed.
 *
 * WHY IT ALSO REPORTS `end`
 * "Not in flight" is at least four different endings — the model finished, the
 * model failed terminally, the prompt never reached this root, and the turn was
 * cut short — and the control plane records exactly one of them per turn. This
 * process is the only one holding the message list, so it names the ending;
 * a caller that only gets a boolean has to guess, and a guess makes
 * `end_reason` unable to name the case it exists for.
 */
export async function observeOpencodeDelivery(
  baseUrl: string,
  workspace: string,
  rootSessionId: string,
  messageId: string,
): Promise<OpencodeDeliveryObservation> {
  const unreadable: OpencodeDeliveryObservation = { inFlight: null, end: null }
  try {
    const response = await fetch(
      `${baseUrl}/session/${encodeURIComponent(rootSessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!response.ok) return unreadable
    const messages = (await response.json()) as Array<{
      info?: {
        id?: string
        role?: string
        parentID?: string
        time?: { completed?: number }
        error?: { data?: { isRetryable?: boolean } }
      }
    }>
    if (!Array.isArray(messages)) return unreadable
    const userIndex = messages.findIndex(
      (message) => message.info?.role === 'user' && message.info.id === messageId,
    )
    // The prompt is not in this root at all — it never landed, or opencode lost
    // it across a restart. The reaper asks only after the full delivery grace,
    // so this is a delivery that failed, not one still on the wire.
    if (userIndex < 0) return { inFlight: false, end: 'abandoned' }

    const after = messages.slice(userIndex + 1)
    const assistants = after.filter(
      (message) => message.info?.role === 'assistant' && message.info.parentID === messageId,
    )
    const latest = assistants[assistants.length - 1]?.info
    // A non-retryable error is the same ending the session.error relay reports,
    // and must carry the same word. A retryable one is still backing off.
    const errored = Boolean(latest?.error) && latest?.error?.data?.isRetryable !== true
    const end: OpencodeTurnEnd | null = errored
      ? 'failed'
      : latest?.time?.completed != null
        ? 'completed'
        : null

    // A hard failure cannot un-fail, and a completed answer stays answered: a
    // busy root next to either is a NEWER turn already running, never this one.
    if (errored) return { inFlight: false, end }
    const newerUser = after.some((message) => message.info?.role === 'user')
    if (newerUser && end === 'completed') return { inFlight: false, end }

    // Every remaining verdict is a claim that the turn DIED, made from
    // transcript shape alone — and transcript shape cannot see a running loop.
    // A prompt forwarded INTO a live turn (and OpenCode's own synthetic
    // `<pty_exited>` wake-ups) put a newer user message on the root while the
    // SAME loop still streams the older turn's steps; and between two steps of
    // one turn the latest assistant message reads completed while tools run
    // and the next step's message does not exist yet. Both shapes read
    // "terminal" here and were: live incident 2026-08-20 (Essentia session
    // d1b74954) — the reaper destroyed a streaming turn's authority at
    // 12:48:51Z on the newer-user rule; its step completed at 12:48:54Z. So no
    // terminal verdict leaves this function while the root itself reports
    // busy, and an unreadable status is unknown, never terminal.
    const busy = await opencodeSessionInFlight(baseUrl, workspace, rootSessionId)
    if (busy === null) return unreadable
    if (busy) return { inFlight: true, end: null }
    if (newerUser) return { inFlight: false, end }
    if (end !== null) return { inFlight: false, end }
    // The root is idle with this turn's assistant message still open: the husk a
    // killed model call leaves behind. With no assistant message at all, the
    // prompt landed and produced nothing, and nothing here says why — but that
    // IS an orphaned prompt, and the inbox can act on it.
    return {
      inFlight: false,
      end: assistants.length > 0 ? 'failed' : null,
      orphanedPrompt: assistants.length === 0,
    }
  } catch {
    return unreadable
  }
}

/** The boolean half of {@link observeOpencodeDelivery}, for callers that only act on it. */
export async function opencodeDeliveryInFlight(
  baseUrl: string,
  workspace: string,
  rootSessionId: string,
  messageId: string,
): Promise<boolean | null> {
  return (await observeOpencodeDelivery(baseUrl, workspace, rootSessionId, messageId)).inFlight
}
