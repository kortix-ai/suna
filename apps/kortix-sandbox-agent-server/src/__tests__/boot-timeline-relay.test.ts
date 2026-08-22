import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { __resetBootTimelineRelayForTests, relayBootTimelineToApi } from '../boot-timeline-relay'

const BASE_ENV = {
  KORTIX_PROJECT_ID: 'proj-1',
  KORTIX_SESSION_ID: 'sess-1',
  KORTIX_TOKEN: 'sandbox-token-abc',
  KORTIX_API_URL: 'https://api.kortix.test/v1',
}

const TIMELINE = [
  { label: 'repo-materialized', atMs: 6686 },
  { label: 'opencode-session-created', atMs: 12066 },
]

const realFetch = globalThis.fetch
const realEnv = { ...process.env }

function setEnv(env: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KORTIX_')) delete process.env[key]
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v
  }
}

beforeEach(() => {
  __resetBootTimelineRelayForTests()
})

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
})

describe('relayBootTimelineToApi', () => {
  test('POSTs the timeline to /v1/platform/boot-timeline with a bearer token', async () => {
    setEnv(BASE_ENV)
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi(TIMELINE)
    await flush()

    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.kortix.test/v1/platform/boot-timeline')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sandbox-token-abc')
    const body = JSON.parse(call.init.body as string)
    expect(body.session_id).toBe('sess-1')
    expect(body.timeline).toEqual(TIMELINE)
    expect(body.project_id).toBeUndefined()
  })

  test('does not append a trailing /v1 twice when KORTIX_API_URL already ends in /v1', async () => {
    setEnv({ ...BASE_ENV, KORTIX_API_URL: 'https://api.kortix.test/v1/' })
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi(TIMELINE)
    await flush()

    expect(calls).toEqual(['https://api.kortix.test/v1/platform/boot-timeline'])
  })

  test('is a silent no-op when KORTIX_API_URL is unset (self-host / local dev with no control plane)', async () => {
    setEnv({ ...BASE_ENV, KORTIX_API_URL: undefined })
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi(TIMELINE)
    await flush()

    expect(calls).toEqual([])
  })

  test('is a silent no-op when no credential is configured', async () => {
    setEnv({ ...BASE_ENV, KORTIX_TOKEN: undefined })
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi(TIMELINE)
    await flush()

    expect(calls).toEqual([])
  })

  test('is a no-op for an empty timeline (nothing worth persisting)', async () => {
    setEnv(BASE_ENV)
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi([])
    await flush()

    expect(calls).toEqual([])
  })

  test('never throws and never blocks the caller when the network call fails', async () => {
    setEnv(BASE_ENV)
    globalThis.fetch = (async () => {
      throw new Error('network unreachable')
    }) as unknown as typeof fetch

    const started = Date.now()
    expect(() => relayBootTimelineToApi(TIMELINE)).not.toThrow()
    expect(Date.now() - started).toBeLessThan(50)
    await flush()
  })

  test('never throws when the server responds non-ok', async () => {
    setEnv(BASE_ENV)
    globalThis.fetch = (async () => new Response('{"error":"nope"}', { status: 500 })) as unknown as typeof fetch

    expect(() => relayBootTimelineToApi(TIMELINE)).not.toThrow()
    await flush()
  })

  test('does not await the network call — returns before the response resolves', async () => {
    setEnv(BASE_ENV)
    let resolveFetch: (() => void) | undefined
    globalThis.fetch = (() =>
      new Promise((resolve) => {
        resolveFetch = () => resolve(new Response('{}', { status: 200 }))
      })) as unknown as typeof fetch

    const before = Date.now()
    relayBootTimelineToApi(TIMELINE)
    expect(Date.now() - before).toBeLessThan(10)
    resolveFetch?.()
    await flush()
  })
  test('relays at most once per boot even though startSessionRuntime has two ready exits', async () => {
    setEnv(BASE_ENV)
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    relayBootTimelineToApi(TIMELINE)
    relayBootTimelineToApi(TIMELINE)
    relayBootTimelineToApi(TIMELINE)
    await flush()

    expect(posts).toBe(1)
  })
})
