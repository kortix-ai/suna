/**
 * The /event subscribe must not wait forever for OpenCode's response headers.
 *
 * Live 2026-08-23 (every box that day, old and new daemon): the loop's first
 * `/event` request went out the instant OpenCode bound its port. OpenCode
 * accepted the connection and never answered it. With no handshake bound the
 * loop sat on that one request for 300 s (Bun's fetch timeout) while the first
 * turn ran, answered, and idled with nobody subscribed — the web showed
 * "Gathering thoughts" until the reaper or the read-path reconcile stepped in.
 * Daemon log: `opencode server listening` 02:46:24 → `[opencode-events]
 * subscribed` 02:51:24, exactly 300 s later, and the retry subscribed in 7 ms.
 *
 * Rule: a subscribe attempt whose headers do not arrive within
 * SUBSCRIBE_HANDSHAKE_TIMEOUT_MS is abandoned and retried on the tight
 * interval. The next attempt, against the now-ready process, subscribes at once.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { SUBSCRIBE_HANDSHAKE_TIMEOUT_MS, startOpencodeEventLoop } from '../opencode-events'
import type { Opencode } from '../opencode'

const loops: Array<{ stop(): void }> = []
const servers: Array<{ stop(closeActive?: boolean): void }> = []
afterEach(() => {
  for (const l of loops.splice(0)) l.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const cfg = { workspace: '/workspace' } as never

function fakeOpencode(port: number): Opencode {
  return { getInternalUrl: () => `http://127.0.0.1:${port}` } as unknown as Opencode
}

/** An /event endpoint that parks the first `hung` requests forever (accepts,
 *  never answers), then streams normally — OpenCode during its first seconds. */
function hangingThenStreamingServer(hung: number) {
  let attempts = 0
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.startsWith('/event')) return new Response('ok')
      attempts++
      if (attempts <= hung) return new Promise<Response>(() => {})
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  servers.push(server)
  return { port: server.port as number, attemptCount: () => attempts }
}

describe('event-loop subscribe handshake bound', () => {
  test('the default bound is seconds, not minutes', () => {
    expect(SUBSCRIBE_HANDSHAKE_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
    expect(SUBSCRIBE_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
  })

  test('a subscribe whose headers never arrive is abandoned and the retry subscribes', async () => {
    const { port, attemptCount } = hangingThenStreamingServer(1)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {}, { subscribeHandshakeTimeoutMs: 150 })
    loops.push(loop)
    const started = Date.now()
    await loop.connected
    const elapsed = Date.now() - started
    expect(attemptCount()).toBeGreaterThanOrEqual(2)
    // 150ms bound + 100ms retry interval, with headroom — and nowhere near 300s.
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect(elapsed).toBeLessThan(2_000)
  }, 10_000)

  test('two hung attempts in a row are both abandoned', async () => {
    const { port, attemptCount } = hangingThenStreamingServer(2)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {}, { subscribeHandshakeTimeoutMs: 120 })
    loops.push(loop)
    const started = Date.now()
    await loop.connected
    expect(attemptCount()).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(2_500)
  }, 10_000)
})
