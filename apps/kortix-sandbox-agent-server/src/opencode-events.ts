import { logger } from './logger'
import type { Config } from './config'
import type { Opencode } from './opencode'

// opencode's QuestionInfo schema, mirrored from the v2 SDK. Anything richer
// (like permission.asked) is layered on top of the same SSE stream.
export interface QuestionInfo {
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

export type OpencodeEventHandlers = {
  onQuestionAsked?: (req: QuestionRequest) => void
  // Fired when an opencode session finishes processing a turn. opencode emits
  // this for EVERY session — including subagent (Task tool) child sessions — so
  // the handler is responsible for filtering down to the root turn.
  onSessionIdle?: (sessionID: string) => void
}

// Subscribe to opencode's SSE event stream and dispatch known event types.
// Auto-reconnects on close — when the underlying opencode supervisor restarts,
// we'll loop reconnecting until /event is reachable again.
export function startOpencodeEventLoop(
  opencode: Opencode,
  cfg: Config,
  handlers: OpencodeEventHandlers,
): { stop(): void } {
  let stopping = false
  let abortController: AbortController | null = null

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

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line.
      let idx = buf.indexOf('\n\n')
      while (idx !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        idx = buf.indexOf('\n\n')
        const dataLines = frame
          .split('\n')
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
    let backoffMs = 1_000
    while (!stopping) {
      try {
        await connectOnce()
      } catch (err) {
        if (stopping) return
        logger.warn('[opencode-events] disconnected — reconnecting', {
          err: (err as Error).message,
          backoffMs,
        })
      }
      if (stopping) return
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 15_000)
    }
  })().catch((err) => logger.error('[opencode-events] loop crashed', err))

  return {
    stop() {
      stopping = true
      abortController?.abort()
    },
  }
}

function dispatch(event: { type?: string; properties?: unknown }, handlers: OpencodeEventHandlers): void {
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
  }
}
