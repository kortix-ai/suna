import { afterEach, describe, expect, test } from 'bun:test'

import { startOpencodeEventLoop } from '../opencode-events'
import type { Opencode } from '../opencode'

const loops: Array<{ stop(): void }> = []
const servers: Array<{ stop(closeActive?: boolean): void }> = []

afterEach(() => {
  for (const l of loops.splice(0)) l.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function fakeOpencode(port: number): Opencode {
  return {
    getInternalUrl: () => `http://127.0.0.1:${port}`,
    getState: () => 'ok',
    getPid: () => 1,
    getBinaryPath: () => '/usr/local/bin/opencode',
    markReady: () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    reconfigure: () => {},
  } as unknown as Opencode
}

/** An /event endpoint that refuses `failures` times before streaming, mimicking
 *  opencode's port being bound but the app not serving yet during a cold boot. */
function flakyEventServer(failures: number) {
  let attempts = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.startsWith('/event')) return new Response('ok')
      attempts++
      if (attempts <= failures) return new Response('not ready', { status: 503 })
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  servers.push(server)
  return { server, port: server.port as number, attemptCount: () => attempts }
}

function eventServerWithChunks(chunks: string[]) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.startsWith('/event')) return new Response('ok')
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  servers.push(server)
  return { server, port: server.port as number }
}

function eventServerWithFrame(frame: string) {
  return eventServerWithChunks([frame])
}

const cfg = { workspace: '/workspace' } as never

describe('event-loop boot race — the SSE subscribe must not sleep through opencode becoming ready', () => {
  test('subscribes promptly after several pre-connect refusals', async () => {
    const { port } = flakyEventServer(8)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {})
    loops.push(loop)

    const started = Date.now()
    await loop.connected
    const elapsed = Date.now() - started

    // Flat 100ms retries: 8 refusals ≈ 800ms. Exponential backoff from 250ms
    // would need 250+500+1000+2000+4000+8000+15000 ≈ 30s for the same count,
    // and the caller's 10s race would have already given up.
    expect(elapsed).toBeLessThan(3_000)
  }, 20_000)

  test('connects on the first attempt with no artificial delay', async () => {
    const { port } = flakyEventServer(0)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {})
    loops.push(loop)

    const started = Date.now()
    await loop.connected
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 20_000)

  test('fires onConnected once the subscription is live', async () => {
    const { port } = flakyEventServer(3)
    let connectedCalls = 0
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {
      onConnected: () => {
        connectedCalls++
      },
    })
    loops.push(loop)

    await loop.connected
    expect(connectedCalls).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test('reconciles periodically when a terminal SSE frame is lost', async () => {
    const { port } = flakyEventServer(0)
    let reconciliations = 0
    const loop = startOpencodeEventLoop(
      fakeOpencode(port),
      cfg,
      {
        onReconcile: () => {
          reconciliations++
        },
      },
      { reconcileIntervalMs: 10 },
    )
    loops.push(loop)

    await loop.connected
    const deadline = Date.now() + 1_000
    while (reconciliations < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(reconciliations).toBeGreaterThanOrEqual(2)
  }, 20_000)

  test('dispatches an event framed with CRLF line endings', async () => {
    const event = {
      type: 'session.updated',
      properties: { info: { id: 'ses_crlf' } },
    }
    const { port } = eventServerWithFrame(`data: ${JSON.stringify(event)}\r\n\r\n`)
    const observed: string[] = []
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {
      onEvent: (candidate) => {
        if (candidate.type) observed.push(candidate.type)
      },
    })
    loops.push(loop)

    await loop.connected
    await Bun.sleep(50)
    expect(observed).toEqual(['session.updated'])
  }, 20_000)

  test('dispatches a CRLF frame whose delimiter spans reader chunks', async () => {
    const event = {
      type: 'session.idle',
      properties: { sessionID: 'ses_split' },
    }
    const encoded = `data: ${JSON.stringify(event)}\r\n\r\n`
    const { port } = eventServerWithChunks([
      encoded.slice(0, -3),
      encoded.slice(-3, -1),
      encoded.slice(-1),
    ])
    const observed: string[] = []
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {
      onEvent: (candidate) => {
        if (candidate.type) observed.push(candidate.type)
      },
    })
    loops.push(loop)

    await loop.connected
    await Bun.sleep(50)
    expect(observed).toEqual(['session.idle'])
  }, 20_000)

  test('keeps retrying rather than giving up while opencode is still unavailable', async () => {
    const { port, attemptCount } = flakyEventServer(Number.MAX_SAFE_INTEGER)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {})
    loops.push(loop)

    const deadline = Date.now() + 5_000
    while (attemptCount() <= 2 && Date.now() < deadline) {
      await Bun.sleep(25)
    }
    expect(attemptCount()).toBeGreaterThan(2)
  }, 20_000)
})
