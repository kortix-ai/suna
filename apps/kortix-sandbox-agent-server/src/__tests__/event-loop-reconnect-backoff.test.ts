/**
 * A drop after a HEALTHY subscription reconnects on the tight interval.
 *
 * The loop backs off between attempts so a sick OpenCode is not hammered. But
 * the backoff never reset after a successful subscription: every drop — and
 * each `/global/dispose` reload (which closes every /event stream, verified
 * live 2026-08-23) and each verified restart IS a drop — doubled it: 100ms,
 * 500ms, 1s, 2s, 4s, 8s, 15s. A session's sixth env-changing prompt forwarded
 * into an 8s unsubscribed gap, and a short answer idled inside it.
 *
 * Rule: only consecutive FAILED attempts back off. A subscription that lived
 * at least `healthySubscriptionMs` resets the backoff, so the reconnect after
 * an expected drop is ~100ms every time.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { createEventSubscriptionState } from '../event-subscription'
import { startOpencodeEventLoop } from '../opencode-events'
import type { Config } from '../config'
import type { Opencode } from '../opencode'

const loops: Array<{ stop(): void }> = []
const servers: Array<{ stop(closeActive?: boolean): void }> = []
afterEach(() => {
  for (const l of loops.splice(0)) l.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function eventServer() {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
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

describe('event-loop reconnect after a healthy subscription', () => {
  test('four consecutive drops each reconnect within the tight interval (no growing backoff)', async () => {
    const state = createEventSubscriptionState()
    let current = eventServer()
    const opencode = { getInternalUrl: () => current.url } as unknown as Opencode
    const loop = startOpencodeEventLoop(opencode, cfg, {}, { subscription: state, healthySubscriptionMs: 30 })
    loops.push(loop)
    await loop.connected
    expect(await state.waitUntilLiveFor(current.url, 1_000)).toBe(true)

    const latencies: number[] = []
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(60) // the subscription was healthy for longer than healthySubscriptionMs
      const previous = current
      current = eventServer() // the replacement process is already serving (dispose/verified swap)
      const waiter = state.waitUntilLiveFor(current.url, 3_000)
      const droppedAt = Date.now()
      previous.server.stop(true)
      expect(await waiter).toBe(true)
      latencies.push(Date.now() - droppedAt)
    }
    // Old behaviour: 100, 500, 1000, 2000 ms. New: ~100 ms each.
    for (const ms of latencies) expect(ms).toBeLessThan(450)
  }, 20_000)
})
