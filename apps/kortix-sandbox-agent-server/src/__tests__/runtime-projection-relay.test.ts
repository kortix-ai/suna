import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'

import {
  __resetRuntimeProjectionRelayForTests,
  registerRuntimeStateReader,
  createSessionTreeWatch,
  scheduleRuntimeProjectionPush,
  shedProjectionToFit,
} from '@/harness/shared/projection-relay'
import { resetRuntimeStateForTests } from '@/harness/open-code/runtime-state-projection'
import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
} from '@/lib/kortix-api/session-token-health'

const BASE_ENV = {
  KORTIX_PROJECT_ID: 'proj-1',
  KORTIX_SESSION_ID: 'sess-1',
  KORTIX_TOKEN: 'sandbox-token-abc',
  KORTIX_API_URL: 'https://api.kortix.test/v1',
  // Tight timings so the suite stays fast; the defaults are 2000/2000.
  KORTIX_PROJECTION_RELAY_DEBOUNCE_MS: '5',
  KORTIX_PROJECTION_RELAY_RETRY_MS: '10',
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    epoch: 'epoch-a',
    seq: 41,
    built_at: '2026-08-27T00:00:00.000Z',
    identity: {
      opencode_session_id: 'ses_abc',
      opencode_version: '1.18.23',
      daemon_build: 1756240000,
      agent_config_etag: null,
      head_seq: { ses_abc: 2016 },
    },
    agents: {
      known: true,
      value: [
        { name: 'build', mode: 'primary', tool_ids: ['bash', 'edit'], skills: ['anydoc'] },
      ],
    },
    commands: { known: true, value: [{ name: 'init', template_bytes: 1483 }] },
    config: { known: true, value: { model: 'kortix/gpt-5.6-sol' } },
    sessions: { known: true, value: [] },
    statuses: { known: true, value: {} },
    permissions: { known: true, value: [] },
    questions: { known: true, value: [] },
    ...overrides,
  }
}

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

function readerFor(doc: unknown, etag: string) {
  return async () => ({ doc: doc as never, etag })
}

/** Wait until the debounce (and any retry) has had time to fire. */
async function settle(ms = 40) {
  await new Promise((r) => setTimeout(r, ms))
}

function decompress(body: unknown): Record<string, unknown> {
  const buf = Buffer.from(body as Uint8Array)
  return JSON.parse(gunzipSync(buf).toString('utf8')) as Record<string, unknown>
}

beforeEach(() => {
  __resetRuntimeProjectionRelayForTests()
  resetSessionTokenHealthForTests()
  setEnv(BASE_ENV)
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
  __resetRuntimeProjectionRelayForTests()
  resetSessionTokenHealthForTests()
})

describe('scheduleRuntimeProjectionPush', () => {
  // relay-context.test.ts owns the per-variable table. The projection route is
  // session-scoped, so unlike the turn relays it does not need a project id.
  test.each([
    ['KORTIX_API_URL', 0],
    ['KORTIX_TOKEN', 0],
    ['KORTIX_SESSION_ID', 0],
    ['KORTIX_PROJECT_ID', 1],
  ] as const)('with %s unset it makes %i POST(s)', async (key, expected) => {
    setEnv({ ...BASE_ENV, [key]: undefined })
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toHaveLength(expected)
  })

  test('is a silent no-op when no runtime state store is configured (default reader, cold boot)', async () => {
    // No registerRuntimeStateReader: the default reader consults
    // runtimeStateStore(). Reset the process singleton explicitly — another
    // test FILE in the same bun process may have configured it.
    resetRuntimeStateForTests()
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toEqual([])
  })

  test('debounces: a burst of triggers produces exactly one POST', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    scheduleRuntimeProjectionPush('mcp.tools.changed')
    scheduleRuntimeProjectionPush('plugin.added')
    await settle()

    expect(posts).toBe(1)
  })

  test('suppresses a push whose etag already landed; pushes again when the etag changes', async () => {
    let etag = 'etag-1'
    registerRuntimeStateReader(async () => ({ doc: makeDoc() as never, etag }))
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()
    expect(posts).toBe(1)

    scheduleRuntimeProjectionPush('kortix-env-applied')
    await settle()
    expect(posts).toBe(1) // same etag: suppressed

    etag = 'etag-2'
    scheduleRuntimeProjectionPush('kortix-env-applied')
    await settle()
    expect(posts).toBe(2)
  })

  // KRTX-446: the projection push re-fires on every boot/change trigger, and a
  // box that outlives its session kept re-issuing `POST .../runtime-projection
  // -> 401`. Once the shared breaker reports the credential dead (here the
  // revoked-token refusal), the relay must issue nothing.
  test('does not push while the control plane has affirmed the session credential is dead', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
      noteControlPlaneResponse(401, 'PAT not found or revoked')
    }
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toEqual([])
  })

  test('never throws and never blocks the caller, even when fetch rejects', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    globalThis.fetch = (async () => {
      throw new Error('network unreachable')
    }) as unknown as typeof fetch

    const started = Date.now()
    expect(() => scheduleRuntimeProjectionPush('boot')).not.toThrow()
    expect(Date.now() - started).toBeLessThan(50)
    await settle()
  })

  test('a failed push does not poison etag suppression — the next trigger retries', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    let posts = 0
    let fail = true
    globalThis.fetch = (async () => {
      posts++
      if (fail) return new Response('{"error":"boom"}', { status: 500 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()
    expect(posts).toBe(1)

    fail = false
    scheduleRuntimeProjectionPush('boot')
    await settle()
    expect(posts).toBe(2) // same etag, but it never landed, so it is retried
  })

  test('on 413 it sheds tool_ids → skills → commands and retries exactly once', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    const bodies: Record<string, unknown>[] = []
    let first = true
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(decompress(init.body))
      if (first) {
        first = false
        return new Response('{"error":"too big"}', { status: 413 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(bodies.length).toBe(2)
    const full = bodies[0]!.projection as Record<string, unknown>
    const shed = bodies[1]!.projection as Record<string, unknown>
    // First attempt carried everything.
    const fullAgents = (full.agents as { value: Record<string, unknown>[] }).value
    expect(fullAgents[0]!.tool_ids).toEqual(['bash', 'edit'])
    // The retry shed the ladder in order.
    const shedAgents = (shed.agents as { value: Record<string, unknown>[] }).value
    expect(shedAgents[0]!.tool_ids).toBeUndefined()
    expect(shedAgents[0]!.skills).toBeUndefined()
    expect(shedAgents[0]!.name).toBe('build') // shedding strips fields, not agents
    const shedCommands = shed.commands as { known: boolean; value: unknown[] }
    expect(shedCommands.known).toBe(false)
    expect(shedCommands.value).toEqual([])
  })

  test('a still-413 retry gives up: exactly two attempts, no loop', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      return new Response('{"error":"too big"}', { status: 413 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(posts).toBe(2)
  })

  test('on 503 it retries on a backoff ladder and succeeds', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      if (posts < 3) return new Response('{"error":"busy"}', { status: 503 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle(250)

    expect(posts).toBe(3)
  })

  test("a 503 with Retry-After waits the server's delay, not the ladder step", async () => {
    // The ladder base here is 10 ms; Retry-After: 1 asks for 1 s.
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    const at: number[] = []
    globalThis.fetch = (async () => {
      at.push(performance.now())
      if (at.length === 1) {
        return new Response('{"error":"busy"}', { status: 503, headers: { 'Retry-After': '1' } })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle(250)
    expect(at).toHaveLength(1)
    await settle(1_000)
    expect(at).toHaveLength(2)
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950)
  })

  test('503 retries are bounded — a permanently unavailable API is abandoned', async () => {
    registerRuntimeStateReader(readerFor(makeDoc(), 'etag-1'))
    let posts = 0
    globalThis.fetch = (async () => {
      posts++
      return new Response('{"error":"busy"}', { status: 503 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle(400)

    expect(posts).toBe(4) // the initial attempt + 3 ladder retries
  })
})

describe('shedProjectionToFit', () => {
  test('sheds in order — tool_ids, then skills, then commands — until the document fits', () => {
    // tool_ids alone dominates the size, so shedding stops after step one.
    const fat = makeDoc({
      agents: {
        known: true,
        value: [{ name: 'build', tool_ids: Array.from({ length: 5000 }, (_, i) => `tool-${i}`), skills: ['a'] }],
      },
    })
    const cap = JSON.stringify(fat).length - 1000
    const { projection, shed } = shedProjectionToFit(fat as never, cap)
    expect(shed).toEqual(['tool_ids'])
    const agents = (projection as unknown as Record<string, unknown>).agents as { value: Record<string, unknown>[] }
    expect(agents.value[0]!.tool_ids).toBeUndefined()
    expect(agents.value[0]!.skills).toEqual(['a']) // step two never ran
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(cap)
  })

  test('never mutates the input document', () => {
    const doc = makeDoc()
    shedProjectionToFit(doc as never, 10)
    const agents = doc.agents as { value: Record<string, unknown>[] }
    expect(agents.value[0]!.tool_ids).toEqual(['bash', 'edit'])
    expect((doc.commands as { known: boolean }).known).toBe(true)
  })

  test('a shed commands section is known:false with a reason, never an empty list presented as fact', () => {
    const doc = makeDoc()
    const { projection, shed } = shedProjectionToFit(doc as never, 100)
    expect(shed).toEqual(['tool_ids', 'skills', 'commands'])
    const commands = (projection as unknown as Record<string, unknown>).commands as {
      known: boolean
      reason?: string
      value: unknown[]
    }
    expect(commands.known).toBe(false)
    expect(commands.reason).toContain('shed')
    expect(commands.value).toEqual([])
  })
})

describe('against a real socket', () => {
  test('a real HTTP sink receives the gzipped projection at /v1/platform/runtime-projection, and the landed etag suppresses a repeat', async () => {
    const received: {
      method: string
      path: string
      auth: string | null
      encoding: string | null
      contentType: string | null
      body: Record<string, unknown>
    }[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const raw = Buffer.from(await req.arrayBuffer())
        received.push({
          method: req.method,
          path: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          encoding: req.headers.get('content-encoding'),
          contentType: req.headers.get('content-type'),
          body: JSON.parse(gunzipSync(raw).toString('utf8')) as Record<string, unknown>,
        })
        return Response.json({ ok: true, stored: 'stored', etag: 'etag-real' })
      },
    })
    try {
      setEnv({ ...BASE_ENV, KORTIX_API_URL: `http://127.0.0.1:${server.port}` })
      const doc = makeDoc()
      registerRuntimeStateReader(readerFor(doc, 'etag-real'))

      scheduleRuntimeProjectionPush('boot')
      await settle(100)

      expect(received.length).toBe(1)
      // A base URL with no /v1 gains exactly one.
      expect(received[0]!.method).toBe('POST')
      expect(received[0]!.path).toBe('/v1/platform/runtime-projection')
      expect(received[0]!.auth).toBe('Bearer sandbox-token-abc')
      expect(received[0]!.encoding).toBe('gzip')
      expect(received[0]!.contentType).toBe('application/json')
      expect(received[0]!.body).toEqual({
        session_id: 'sess-1',
        captured_at: '2026-08-27T00:00:00.000Z',
        projection_etag: 'etag-real',
        projection: doc as never,
      })

      // And the landed etag now suppresses a repeat.
      scheduleRuntimeProjectionPush('boot')
      await settle(100)
      expect(received.length).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})

// R7.4: apps/api lists a session's runtime conversations from the pushed projection.
describe('createSessionTreeWatch', () => {
  const frame = (type: string, id: string, title?: string) => ({ type, properties: { sessionID: id, info: { id, ...(title === undefined ? {} : { title }) } } })

  test('a new session, a new title and a deleted session change the tree; a repeat or another frame does not', () => {
    const changed = createSessionTreeWatch()
    expect(changed(frame('session.created', 'ses_root', 'New session'))).toBe(true)
    // OpenCode sends session.updated on every step: unchanged title, no push.
    expect(changed(frame('session.updated', 'ses_root', 'New session'))).toBe(false)
    expect(changed(frame('session.updated', 'ses_root', 'Fix the login bug'))).toBe(true)
    expect(changed(frame('session.updated', 'ses_root', 'Fix the login bug'))).toBe(false)
    expect(changed(frame('session.created', 'ses_child', 'Review the change'))).toBe(true)
    expect(changed(frame('message.updated', 'ses_child', 'x'))).toBe(false)
    expect(changed(frame('session.deleted', 'ses_child'))).toBe(true)
    // A session first seen in an update is new to the tree.
    expect(changed(frame('session.updated', 'ses_late', 'Late'))).toBe(true)
    expect(changed({ type: 'session.created', properties: {} })).toBe(false)
  })
})
