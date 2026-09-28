/**
 * SSE keepalive injection for proxied event streams (`/global/event`).
 *
 * No layer between opencode and the browser emits a byte on a quiet stream —
 * not opencode, not this proxy, not the api proxy — so the SDK's 60s
 * heartbeat was the ONLY detector of a dead stream, and the path can die
 * silently in ways nothing logs: a stale cached ingress at the api that
 * answers 200 and never writes, a stalled edge hop, the ALB's 300s idle
 * timeout on a quiet session. Sessions froze mid-turn with the transcript
 * minutes behind (prod, 2026-08-26).
 *
 * This proxy runs INSIDE the sandbox, one localhost hop from opencode, so a
 * keepalive it emits proves the entire daemon → edge → api → browser path.
 * While keepalives flow, the client heartbeat firing means the PATH died —
 * a true positive worth an immediate reconnect; while they don't, the
 * heartbeat's 60s budget (3× this cadence) is the detector it always was.
 *
 * Two wire-format rules, each load-bearing (see the test file):
 *
 *  - The frame is a REAL typed event, not a `:` comment. SSE parsers swallow
 *    comments without yielding anything, so a comment would keep TCP and the
 *    ALB warm while leaving every consumer's liveness watchdog blind. The
 *    type `kortix.keepalive` matches no handler in the SDK, the web app, or
 *    mobile — every consumer's switch drops it after its heartbeat reset.
 *  - It is injected only at an EVENT BOUNDARY (after a blank line, or before
 *    any bytes). The frame carries the dispatching blank line, so injecting
 *    it mid-event would flush a half-written event to every consumer.
 *
 * Backpressure is preserved: the wrapper reads the upstream one chunk per
 * `pull`, so a slow browser connection still throttles the opencode read the
 * way the native `Response(upstream.body)` pipe did.
 */

export const SSE_KEEPALIVE_INTERVAL_MS = 20_000
export const SSE_KEEPALIVE_FRAME = 'data: {"type":"kortix.keepalive"}\n\n'

/** Injectable clock/timer seam so tests drive the cadence deterministically. */
export interface SseKeepaliveTimers {
  now: () => number
  setInterval: (handler: () => void, intervalMs: number) => unknown
  clearInterval: (handle: unknown) => void
}

const realTimers: SseKeepaliveTimers = {
  now: () => Date.now(),
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

const NL = 0x0a
const CR = 0x0d

/**
 * Whether the stream position after `tail` (the last ≤3 bytes seen) is an
 * event boundary: the byte stream so far ends with a blank line — `\n\n`,
 * `\n\r\n`, or `\r\n\r\n` (whose 3-byte suffix is `\n\r\n`). The stream
 * start counts as a boundary (empty tail).
 */
function isEventBoundary(tail: number[]): boolean {
  if (tail.length === 0) return true
  const last = tail[tail.length - 1]
  if (last !== NL) return false
  if (tail.length < 2) return false
  const beforeLast = tail[tail.length - 2]
  if (beforeLast === NL) return true
  return beforeLast === CR && tail.length >= 3 && tail[tail.length - 3] === NL
}

/**
 * Wrap an SSE response body so a typed keepalive event is injected after
 * every `intervalMs` of upstream silence, at event boundaries only.
 */
export function withSseKeepalive(
  upstream: ReadableStream<Uint8Array>,
  options: { intervalMs?: number; timers?: SseKeepaliveTimers } = {},
): ReadableStream<Uint8Array> {
  const t = options.timers ?? realTimers
  const intervalMs = options.intervalMs ?? SSE_KEEPALIVE_INTERVAL_MS
  const reader = upstream.getReader()
  const frameBytes = new TextEncoder().encode(SSE_KEEPALIVE_FRAME)

  let lastActivityAt = t.now()
  // Last ≤3 bytes seen, across chunk boundaries — the boundary test's input.
  let tail: number[] = []
  let finished = false
  let timer: unknown

  const stopTimer = () => {
    if (timer === undefined) return
    t.clearInterval(timer)
    timer = undefined
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = t.setInterval(() => {
        if (finished) return
        if (t.now() - lastActivityAt < intervalMs) return
        if (!isEventBoundary(tail)) return
        try {
          controller.enqueue(frameBytes)
        } catch {
          // The consumer is gone; `cancel` (or the pending pull) cleans up.
          return
        }
        lastActivityAt = t.now()
      }, intervalMs)
    },
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>
      try {
        result = await reader.read()
      } catch (err) {
        finished = true
        stopTimer()
        try {
          controller.error(err)
        } catch {
          // Already errored/closed.
        }
        return
      }
      if (result.done) {
        finished = true
        stopTimer()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
        return
      }
      const chunk = result.value
      if (chunk && chunk.length > 0) {
        lastActivityAt = t.now()
        tail = [...tail, ...chunk.slice(Math.max(0, chunk.length - 3))].slice(-3)
        try {
          controller.enqueue(chunk)
        } catch {
          // The consumer is gone mid-pull; `cancel` cleans up the reader.
        }
      }
    },
    cancel(reason) {
      finished = true
      stopTimer()
      return reader.cancel(reason)
    },
  })
}
