import { logger } from './logger'
import type { Config } from './config'
import type { Opencode } from './opencode'

// opencode's QuestionInfo schema, mirrored from the v2 SDK. Anything richer
// (like permission.asked) is layered on top of the same SSE stream.
interface QuestionInfo {
  question: string
  header: string
  options: Array<{ value: string; label?: string }>
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

// Flattened opencode error (from session.error / AssistantMessage.error), passed
// to onSessionError so the turn-end relay can tell apps/api *why* a run failed
// (out of credits, rate limit, provider auth, …) instead of a blank "no reply".
export interface OpencodeTurnError {
  /** opencode error name, e.g. `APIError` / `ProviderAuthError` / `MessageAbortedError`. */
  name?: string
  /** Human message from `error.data.message`. */
  message?: string
  /** Upstream HTTP status for an `APIError` (402 = credits, 429 = rate limit). */
  statusCode?: number
  /** `APIError.data.isRetryable` — opencode's own transient/permanent signal. */
  isRetryable?: boolean
  /** `ProviderAuthError.data.providerID` — lets the Slack copy name the provider. */
  providerID?: string
}

type OpencodeEventHandlers = {
  /** Every parsed OpenCode event, before specialized dispatch. */
  onEvent?: (event: { type?: string; properties?: unknown }) => void
  onQuestionAsked?: (req: QuestionRequest) => void
  // Fired when an opencode session finishes processing a turn (idle) or dies
  // mid-turn (error). opencode emits these for EVERY session — including
  // subagent (Task tool) child sessions — so the handler is responsible for
  // filtering down to the root turn.
  onSessionIdle?: (sessionID: string) => void
  onSessionError?: (sessionID: string, error?: OpencodeTurnError) => void
  // Fired every time the /event SSE (re)subscribes successfully. Used to
  // reconcile a turn that finished BEFORE the subscription was live: a fast
  // boot could reach session.idle inside the gap between prompt_async and the
  // subscribe, so we read the root's last-turn state on connect and relay a
  // synthetic turn-end if it already completed. Belt-and-suspenders next to the
  // subscribe-before-prompt ordering — makes finalize independent of subscription
  // timing.
  onConnected?: () => void
}

// Subscribe to opencode's SSE event stream and dispatch known event types.
// Auto-reconnects on close — when the underlying opencode supervisor restarts,
// we'll loop reconnecting until /event is reachable again.
export function startOpencodeEventLoop(
  opencode: Opencode,
  cfg: Config,
  handlers: OpencodeEventHandlers,
): { stop(): void; connected: Promise<void> } {
  let stopping = false
  let abortController: AbortController | null = null
  // Resolves the FIRST time the SSE subscribes. The initial-prompt path awaits
  // this before firing prompt_async so the subscription is guaranteed live
  // before the first turn is launched — closing the fast-boot event-loss race.
  let markConnected: () => void
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve
  })
  // Distinguishes "opencode hasn't bound its port yet" (boot race, retry tight)
  // from "an established subscription dropped" (real fault, back off). See the
  // retry loop below.
  let everConnected = false

  async function connectOnce(): Promise<void> {
    const url = `${opencode.getInternalUrl()}/event?directory=${encodeURIComponent(cfg.workspace)}`
    abortController = new AbortController()
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: abortController.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`/event subscribe non-ok: ${res.status}`)
    }
    logger.info('[opencode-events] subscribed')
    everConnected = true
    markConnected()
    // Reconcile any turn that finished before this subscription was live. Fires
    // on every (re)connect; the handler is idempotent (per-turn dedup), so a
    // reconnect after the turn already relayed is a no-op.
    handlers.onConnected?.()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      // SSE permits LF and CRLF line endings. OpenCode can emit CRLF frames,
      // including when the delimiter spans reader chunks, so retain the raw
      // buffer and consume the complete delimiter returned by the match.
      let boundary = /\r?\n\r?\n/.exec(buf)
      while (boundary?.index !== undefined) {
        const frame = buf.slice(0, boundary.index)
        buf = buf.slice(boundary.index + boundary[0].length)
        boundary = /\r?\n\r?\n/.exec(buf)
        const dataLines = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter(Boolean)
        if (dataLines.length === 0) continue
        try {
          const event = JSON.parse(dataLines.join('\n')) as {
            type?: string
            properties?: unknown
          }
          dispatch(event, handlers)
        } catch (err) {
          logger.warn('[opencode-events] parse failed', { err: (err as Error).message })
        }
      }
    }
  }

  ;(async () => {
    // Two DIFFERENT retry regimes, because the pre-connect and post-connect
    // failures mean opposite things.
    //
    // Before the first successful subscribe, every failure is just "opencode
    // hasn't bound its port yet" — a boot race, not a fault. And this is ON the
    // critical path: maybeCreateInitialOpencodeSession blocks on `connected`
    // before delivering the first prompt, and `opencode-session-created` (4.7s
    // Daytona / 12.0s Platinum p50) is stamped after it. Exponential backoff
    // here actively hurts: with attempts at 0/0.25/0.75/1.75/3.75/7.75s, an
    // opencode that becomes ready at t=5s isn't noticed until t=7.75s — ~2.7s of
    // pure dead time, sleeping through the readiness it was waiting for. The old
    // code's own comment said "a fast retry minimizes the added latency" and
    // then doubled to 15s, defeating exactly that intent.
    //
    // So: poll at a FLAT tight interval until connected once (bounded by the
    // caller's own 10s race), then switch to exponential backoff, where it is
    // correct — a drop after a successful subscribe is a real fault and
    // hammering a sick opencode makes it worse.
    const PRE_CONNECT_RETRY_MS = 100
    const POST_CONNECT_BACKOFF_START_MS = 250
    let backoffMs = PRE_CONNECT_RETRY_MS
    while (!stopping) {
      try {
        await connectOnce()
      } catch (err) {
        if (stopping) return
        // Pre-connect failures are the expected boot race; don't log them as
        // disconnects (it made a normal cold boot look broken).
        if (everConnected) {
          logger.warn('[opencode-events] disconnected — reconnecting', {
            err: (err as Error).message,
            backoffMs,
          })
        }
      }
      if (stopping) return
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs = everConnected
        ? Math.min(Math.max(backoffMs, POST_CONNECT_BACKOFF_START_MS) * 2, 15_000)
        : PRE_CONNECT_RETRY_MS
    }
  })().catch((err) => logger.error('[opencode-events] loop crashed', err))

  return {
    stop() {
      stopping = true
      abortController?.abort()
    },
    connected,
  }
}

// Flatten opencode's nested error ({ name, data: { message, statusCode,
// isRetryable, providerID } }) into the wire shape apps/api classifies. Shared
// by the session.error dispatch and the idle-time last-message read so both
// carry the same fields. Exported for unit testing.
export function flattenOpencodeError(e: {
  name?: string
  data?: { message?: string; statusCode?: number; isRetryable?: boolean; providerID?: string }
}): OpencodeTurnError {
  return {
    name: e.name,
    message: e.data?.message,
    statusCode: e.data?.statusCode,
    isRetryable: e.data?.isRetryable,
    providerID: e.data?.providerID,
  }
}

// Exported for unit testing — maps a raw opencode SSE event to a handler call,
// including flattening session.error's nested error into OpencodeTurnError.
export function dispatch(event: { type?: string; properties?: unknown }, handlers: OpencodeEventHandlers): void {
  handlers.onEvent?.(event)
  if (event.type === 'question.asked' && handlers.onQuestionAsked) {
    const req = event.properties as QuestionRequest
    if (req?.id && req?.sessionID && Array.isArray(req.questions)) {
      handlers.onQuestionAsked(req)
    }
    return
  }
  if (event.type === 'session.idle' && handlers.onSessionIdle) {
    const props = event.properties as { sessionID?: string } | undefined
    if (props?.sessionID) handlers.onSessionIdle(props.sessionID)
    return
  }
  if (event.type === 'session.error' && handlers.onSessionError) {
    const props = event.properties as
      | {
          sessionID?: string
          error?: {
            name?: string
            data?: { message?: string; statusCode?: number; isRetryable?: boolean; providerID?: string }
          }
        }
      | undefined
    if (props?.sessionID) {
      const e = props.error
      handlers.onSessionError(props.sessionID, e ? flattenOpencodeError(e) : undefined)
    }
  }
}
