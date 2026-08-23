import { afterEach, describe, expect, test } from 'bun:test'

import { createEventSubscriptionState } from '../event-subscription'
import { startOpencodeEventLoop } from '../opencode-events'
import type { Config } from '../config'
import type { Opencode } from '../opencode'

// The /event subscription's liveness is keyed by the OpenCode URL it is
// subscribed to. A verified reload promotes a NEW process on the other port,
// so "live" must mean "subscribed to the process that is serving NOW", or the
// env route would forward a prompt into the old process's dead stream.

const servers: Array<{ stop(closeActive?: boolean): void }> = []
const loops: Array<{ stop(): void }> = []
afterEach(() => {
  for (const l of loops.splice(0)) l.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function eventServer() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.startsWith('/event')) return new Response('ok')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  servers.push(server)
  return { server, url: `http://127.0.0.1:${server.port}` }
}

const cfg = { workspace: '/workspace' } as unknown as Config

describe('event subscription state', () => {
  test('waitUntilLiveFor resolves false on timeout when nothing subscribed', async () => {
    const state = createEventSubscriptionState()
    const started = Date.now()
    expect(await state.waitUntilLiveFor('http://127.0.0.1:1', 50)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    expect(state.isLiveFor('http://127.0.0.1:1')).toBe(false)
  })

  test('marks live with the subscribed URL, dropped on disconnect, live again on the NEW URL', async () => {
    const state = createEventSubscriptionState()
    const a = eventServer()
    const b = eventServer()
    let current = a.url
    const opencode = { getInternalUrl: () => current } as unknown as Opencode
    const loop = startOpencodeEventLoop(opencode, cfg, {}, { subscription: state })
    loops.push(loop)
    await loop.connected
    expect(await state.waitUntilLiveFor(a.url, 500)).toBe(true)
    expect(state.isLiveFor(b.url)).toBe(false)

    // Verified swap: the active URL moves, then the old process dies.
    current = b.url
    const waiter = state.waitUntilLiveFor(b.url, 2_000)
    a.server.stop(true)
    expect(await waiter).toBe(true)
    expect(state.isLiveFor(a.url)).toBe(false)
    expect(state.isLiveFor(b.url)).toBe(true)
  })

  test('a stale subscription (old URL) is NOT live for the new URL even before the drop is seen', () => {
    const state = createEventSubscriptionState()
    state.markLive('http://127.0.0.1:4096')
    expect(state.isLiveFor('http://127.0.0.1:4096')).toBe(true)
    expect(state.isLiveFor('http://127.0.0.1:4097')).toBe(false)
  })
})

describe('event subscription generation', () => {
  test('generation increments on every markLive; waitUntilLiveAfter ignores the generation it was given', async () => {
    const state = createEventSubscriptionState()
    const url = 'http://127.0.0.1:4096'
    expect(state.generation()).toBe(0)
    state.markLive(url)
    expect(state.generation()).toBe(1)
    // Still live on the same URL, but that is the subscription a dispose is
    // about to close — a wait keyed on the CURRENT generation must not take it.
    const before = state.generation()
    const started = Date.now()
    expect(await state.waitUntilLiveAfter(before, url, 60)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)

    const waiter = state.waitUntilLiveAfter(before, url, 1_000)
    state.markDropped()
    state.markLive(url) // the loop re-subscribed to the same URL
    expect(await waiter).toBe(true)
    expect(state.generation()).toBe(2)
  })

  test('waitUntilLiveAfter resolves at once when a newer generation is already live on the url', async () => {
    const state = createEventSubscriptionState()
    state.markLive('http://127.0.0.1:4096')
    state.markLive('http://127.0.0.1:4097')
    expect(await state.waitUntilLiveAfter(1, 'http://127.0.0.1:4097', 10)).toBe(true)
    expect(await state.waitUntilLiveAfter(1, 'http://127.0.0.1:4096', 10)).toBe(false)
  })
})
