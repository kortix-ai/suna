import { afterEach, describe, expect, test } from 'bun:test'

import { waitForInitialSessionCreate } from '../main'

const servers: Array<{ stop(closeActive?: boolean): void }> = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function sessionServer(opts: { delayMs?: number; failTimes?: number; neverRespond?: boolean }) {
  let posts = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('ok')
      posts++
      if (opts.neverRespond) {
        await new Promise((r) => setTimeout(r, 60_000))
        return new Response('{}')
      }
      if (opts.failTimes && posts <= opts.failTimes) return new Response('starting', { status: 503 })
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      return new Response(JSON.stringify({ id: 'ses_abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  servers.push(server)
  return { port: server.port as number, postCount: () => posts }
}

describe('waitForInitialSessionCreate — a slow opencode must not be duplicated', () => {
  test('waits for a session-create that takes longer than a second instead of resending', async () => {
    const { port, postCount } = sessionServer({ delayMs: 1_600 })

    const res = await waitForInitialSessionCreate(`http://127.0.0.1:${port}`, '/workspace')
    const body = (await res.json()) as { id?: string }

    expect(body.id).toBe('ses_abc')
    expect(postCount()).toBe(1)
  }, 30_000)

  test('still retries while opencode is refusing connections at the app level', async () => {
    const { port, postCount } = sessionServer({ failTimes: 3 })

    const res = await waitForInitialSessionCreate(`http://127.0.0.1:${port}`, '/workspace')
    expect(res.status).toBe(200)
    expect(postCount()).toBe(4)
  }, 30_000)

  test('does not resend after its own timeout, so opencode cannot end up with two roots', async () => {
    const { port, postCount } = sessionServer({ neverRespond: true })

    await expect(
      waitForInitialSessionCreate(`http://127.0.0.1:${port}`, '/workspace'),
    ).rejects.toThrow()
    expect(postCount()).toBe(1)
  }, 40_000)

  test('surfaces a non-retryable 4xx immediately', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('bad request', { status: 400 }),
    })
    servers.push(server)

    await expect(
      waitForInitialSessionCreate(`http://127.0.0.1:${server.port}`, '/workspace'),
    ).rejects.toThrow(/400/)
  }, 30_000)
})
