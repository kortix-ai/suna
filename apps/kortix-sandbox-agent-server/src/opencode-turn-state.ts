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
  /** A queued user message or an incomplete assistant turn still owns runtime. */
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
      return { hasMessages: false, lastTurnIncomplete: false, turnInFlight: false, known: true }
    const last = msgs[msgs.length - 1]
    const lastTurnIncomplete = Boolean(
      last?.info?.role === 'assistant' &&
        !last?.info?.time?.completed &&
        (!last?.info?.error || last.info.error.data?.isRetryable === true),
    )
    return {
      hasMessages: true,
      lastTurnIncomplete,
      turnInFlight: last?.info?.role === 'user' || lastTurnIncomplete,
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
 * Observe one client-minted OpenCode user message for lifecycle recovery.
 *
 * A matching user message with no assistant reply is queued and therefore
 * active. A matching assistant reply is terminal only when it has a completed
 * timestamp. A successful list that lacks the exact message is terminal: the
 * reaper calls this only after the full delivery grace has elapsed.
 */
export async function opencodeDeliveryInFlight(
  baseUrl: string,
  workspace: string,
  rootSessionId: string,
  messageId: string,
): Promise<boolean | null> {
  try {
    const response = await fetch(
      `${baseUrl}/session/${encodeURIComponent(rootSessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!response.ok) return null
    const messages = (await response.json()) as Array<{
      info?: {
        id?: string
        role?: string
        parentID?: string
        time?: { completed?: number }
        error?: { data?: { isRetryable?: boolean } }
      }
    }>
    if (!Array.isArray(messages)) return null
    const userIndex = messages.findIndex(
      (message) => message.info?.role === 'user' && message.info.id === messageId,
    )
    if (userIndex < 0) return false
    const assistants = messages
      .slice(userIndex + 1)
      .filter(
        (message) => message.info?.role === 'assistant' && message.info.parentID === messageId,
      )
    if (assistants.length === 0) return true
    const latest = assistants[assistants.length - 1]?.info
    if (latest?.error && latest.error.data?.isRetryable !== true) return false
    return latest?.time?.completed == null
  } catch {
    return null
  }
}
