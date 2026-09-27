import { afterEach, describe, expect, test } from 'bun:test'

import { startOpencodeEventLoop } from '../harness/open-code/events'
import type { Opencode } from '../harness/open-code/lifecycle'

// OpenCode binds its port ~100 ms before its request handler exists. A request
// accepted in that window is never answered — the client waits for its own
// timeout, and the /event subscribe had none (a stuck subscription for the
// life of the session on S3 boots, 2026-09-15). These tests model that window
// with a raw TCP listener that accepts connections and never writes.

const loops: Array<{ stop(): void }> = []
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const l of loops.splice(0)) l.stop()
  for (const c of cleanups.splice(0)) c()
})

function fakeOpencode(port: number, extra: Partial<Opencode> = {}): Opencode {
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
    ...extra,
  } as unknown as Opencode
}

/** Accepts every connection and never answers the first `dead` of them; the
 *  rest get a minimal SSE response. */
function deadWindowServer(dead: number) {
  let accepted = 0
  const held: Array<{ end(): void }> = []
  const listener = Bun.listen<{ answered: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        accepted++
        socket.data = { answered: false }
        if (accepted <= dead) {
          held.push(socket)
          return
        }
      },
      data(socket) {
        if (socket.data.answered) return
        if (held.includes(socket)) return
        socket.data.answered = true
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n: keepalive\n\n',
        )
      },
      close() {},
      error() {},
    },
  })
  cleanups.push(() => {
    for (const s of held) s.end()
    listener.stop(true)
  })
  return { port: listener.port, acceptedCount: () => accepted }
}

const cfg = { workspace: '/workspace' } as never

describe('event loop vs OpenCode bind→handler window', () => {
  test('a subscribe with no response headers is abandoned and retried', async () => {
    const { port, acceptedCount } = deadWindowServer(1)
    const loop = startOpencodeEventLoop(fakeOpencode(port), cfg, {}, { subscribeHeadersTimeoutMs: 200 })
    loops.push(loop)
    const started = Date.now()
    await loop.connected
    // first attempt dropped (200 ms), second answered
    expect(acceptedCount()).toBeGreaterThanOrEqual(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test('no subscribe is sent before the lifecycle reports the listening announcement', async () => {
    const { port, acceptedCount } = deadWindowServer(0)
    let release!: () => void
    const listening = new Promise<void>((resolve) => {
      release = resolve
    })
    const loop = startOpencodeEventLoop(
      fakeOpencode(port, { waitForCurrentListening: () => listening }),
      cfg,
      {},
      { listeningWaitMaxMs: 5_000 },
    )
    loops.push(loop)
    await Bun.sleep(150)
    expect(acceptedCount()).toBe(0)
    release()
    await loop.connected
    expect(acceptedCount()).toBe(1)
  })

  test('the listening wait is bounded so a dead OpenCode still reaches the retry path', async () => {
    const { port, acceptedCount } = deadWindowServer(0)
    const loop = startOpencodeEventLoop(
      fakeOpencode(port, { waitForCurrentListening: () => new Promise<void>(() => {}) }),
      cfg,
      {},
      { listeningWaitMaxMs: 100 },
    )
    loops.push(loop)
    await loop.connected
    expect(acceptedCount()).toBe(1)
  })
})
