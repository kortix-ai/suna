import { describe, expect, test } from 'bun:test'

import type { Config } from '../config'
import { createRuntimeProxyRouter } from '../routes/runtime-proxy'
import {
  SSE_KEEPALIVE_FRAME,
  SSE_KEEPALIVE_INTERVAL_MS,
  withSseKeepalive,
  type SseKeepaliveTimers,
} from '../sse-keepalive'

/**
 * WHY the daemon injects SSE keepalives (prod, 2026-08-26).
 *
 * No layer between opencode and the browser emits a byte on a quiet stream —
 * not opencode, not this proxy, not the api proxy. The SDK's 60s heartbeat is
 * therefore the ONLY detector of a dead stream, and the path can die silently
 * in ways nothing logs: a stale cached ingress that answers 200 and never
 * writes, an edge hop that stalls, an ALB idle timeout (300s) on a quiet
 * session. Sessions froze mid-turn with the transcript minutes behind.
 *
 * This proxy runs INSIDE the sandbox, one localhost hop from opencode — so a
 * keepalive it emits proves the entire daemon→edge→api→browser path end to
 * end. The frame is a REAL typed event, not a `:` comment, because SSE
 * parsers swallow comments without yielding anything — a comment would warm
 * the TCP path while leaving the SDK heartbeat blind. `kortix.keepalive`
 * matches no handler anywhere, so every consumer treats it as pure liveness.
 *
 * And it may only be injected at an EVENT BOUNDARY: the frame carries the
 * dispatching blank line, so injecting mid-event would flush a half-written
 * event to every consumer.
 */

function fakeTimers() {
  let now = 0
  let handler: (() => void) | undefined
  let intervalMs = 0
  let cleared = 0
  const timers: SseKeepaliveTimers = {
    now: () => now,
    setInterval: (h, ms) => {
      handler = h
      intervalMs = ms
      return 1
    },
    clearInterval: () => {
      cleared += 1
      handler = undefined
    },
  }
  return {
    timers,
    intervalRegistered: () => intervalMs,
    clearedCount: () => cleared,
    advance(ms: number) {
      now += ms
      handler?.()
    },
  }
}

function upstreamOf(controls: { push: (c: string) => void; close: () => void; error?: (e: unknown) => void }[] | null = null) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  const encoder = new TextEncoder()
  return {
    stream,
    push: (chunk: string) => ctrl.enqueue(encoder.encode(chunk)),
    close: () => ctrl.close(),
    fail: (e: unknown) => ctrl.error(e),
  }
}

async function drain(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  decoder: TextDecoder,
  into: string[],
) {
  // Pull everything currently available without blocking the test forever.
  // Each call reads at most one pending chunk.
  const { done, value } = await reader.read()
  if (!done && value) into.push(decoder.decode(value))
  return done
}

describe('withSseKeepalive', () => {
  test('injects a typed keepalive event after a silent interval at an event boundary', async () => {
    const clock = fakeTimers()
    const up = upstreamOf()
    const reader = withSseKeepalive(up.stream, { timers: clock.timers }).getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []

    up.push('data: {"type":"session.status"}\n\n')
    await drain(reader, decoder, seen)

    clock.advance(SSE_KEEPALIVE_INTERVAL_MS)
    await drain(reader, decoder, seen)

    expect(seen).toEqual([
      'data: {"type":"session.status"}\n\n',
      SSE_KEEPALIVE_FRAME,
    ])
    // A REAL event with a type — not an SSE comment (parsers swallow those
    // without yielding, which would leave the SDK heartbeat blind).
    expect(SSE_KEEPALIVE_FRAME.startsWith('data: ')).toBe(true)
    expect(SSE_KEEPALIVE_FRAME.endsWith('\n\n')).toBe(true)
    expect(JSON.parse(SSE_KEEPALIVE_FRAME.slice('data: '.length))).toEqual({
      type: 'kortix.keepalive',
    })
  })

  test('injects from connection start — a stream that never says anything is exactly the case', async () => {
    const clock = fakeTimers()
    const up = upstreamOf()
    const reader = withSseKeepalive(up.stream, { timers: clock.timers }).getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []

    clock.advance(SSE_KEEPALIVE_INTERVAL_MS)
    await drain(reader, decoder, seen)
    expect(seen).toEqual([SSE_KEEPALIVE_FRAME])
  })

  test('never injects mid-event — a chunk that stalls between data lines holds the keepalive', async () => {
    const clock = fakeTimers()
    const up = upstreamOf()
    const reader = withSseKeepalive(up.stream, { timers: clock.timers }).getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []

    // An event split across chunks: the first half ends mid-event (single
    // newline). The frame's blank line would dispatch this half-event.
    up.push('data: {"type":"message.par')
    await drain(reader, decoder, seen)
    clock.advance(SSE_KEEPALIVE_INTERVAL_MS * 3)

    // Upstream completes the event; downstream sees the two halves only.
    up.push('t.updated"}\n\n')
    await drain(reader, decoder, seen)
    expect(seen).toEqual(['data: {"type":"message.par', 't.updated"}\n\n'])

    // Back at a boundary, the next silent interval injects again.
    clock.advance(SSE_KEEPALIVE_INTERVAL_MS)
    await drain(reader, decoder, seen)
    expect(seen[2]).toBe(SSE_KEEPALIVE_FRAME)
  })

  test('a recent upstream chunk postpones the keepalive', async () => {
    const clock = fakeTimers()
    const up = upstreamOf()
    const reader = withSseKeepalive(up.stream, { timers: clock.timers }).getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []

    clock.advance(SSE_KEEPALIVE_INTERVAL_MS - 1)
    up.push('data: {"type":"session.status"}\n\n')
    await drain(reader, decoder, seen)

    // The tick fires with fresh activity: nothing injected.
    clock.advance(1)
    expect(seen).toEqual(['data: {"type":"session.status"}\n\n'])
  })

  test('upstream close ends the stream and stops the timer', async () => {
    const clock = fakeTimers()
    const up = upstreamOf()
    const reader = withSseKeepalive(up.stream, { timers: clock.timers }).getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []

    up.push('data: {"type":"session.idle"}\n\n')
    await drain(reader, decoder, seen)
    up.close()
    const done = await drain(reader, decoder, seen)

    expect(done).toBe(true)
    expect(clock.clearedCount()).toBeGreaterThan(0)
  })

  test('the runtime proxy wraps a 2xx event stream and drops its content-length; other bodies pass as-is', async () => {
    // Drive the real transport router with a stub harness. The keepalive tick
    // is captured instead of waiting 20 s, and the clock is moved past it.
    const upstreams: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const runtime = {
      blockedPorts: () => [],
      readiness: async () => ({ ready: true as const }),
      forward: async (input: { path: string }) => {
        const sse = input.path === '/event'
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers({
            'content-type': sse ? 'text/event-stream' : 'application/json',
            'content-length': '999',
          }),
          body: new ReadableStream<Uint8Array>({ start: (c) => void upstreams.push(c) }),
        }
      },
    }
    const router = createRuntimeProxyRouter(
      { cfg: {} as Config, bootState: { repoMaterializationError: null, timeline: [] } },
      runtime,
    )

    const realSetInterval = globalThis.setInterval
    const realNow = Date.now
    const ticks: Array<{ tick: () => void; ms: number | undefined }> = []
    globalThis.setInterval = ((tick: () => void, ms?: number) => {
      ticks.push({ tick, ms })
      return realSetInterval(() => {}, 1 << 30)
    }) as typeof setInterval
    try {
      const plain = await router.request('/session')
      expect(plain.headers.get('content-length')).toBe('999')
      expect(ticks).toHaveLength(0)

      const res = await router.request('/event')
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(res.headers.get('content-length')).toBeNull()
      const reader = res.body!.getReader()
      const first = reader.read()
      expect(ticks.map((t) => t.ms)).toEqual([SSE_KEEPALIVE_INTERVAL_MS])
      Date.now = () => realNow() + SSE_KEEPALIVE_INTERVAL_MS + 1_000
      ticks[0]!.tick()
      expect(new TextDecoder().decode((await first).value)).toBe(SSE_KEEPALIVE_FRAME)
      await reader.cancel()
    } finally {
      globalThis.setInterval = realSetInterval
      Date.now = realNow
      for (const upstream of upstreams) {
        try {
          upstream.close()
        } catch {}
      }
    }
  })

  test('downstream cancel propagates to the upstream reader and stops the timer', async () => {
    const clock = fakeTimers()
    let cancelled: unknown = null
    const upstream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason ?? 'cancelled'
      },
    })
    const wrapped = withSseKeepalive(upstream, { timers: clock.timers })
    await wrapped.cancel('client gone')

    expect(cancelled).toBe('client gone')
    expect(clock.clearedCount()).toBeGreaterThan(0)
  })
})
