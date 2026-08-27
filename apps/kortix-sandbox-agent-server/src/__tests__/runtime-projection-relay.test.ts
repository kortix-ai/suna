import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'

import {
  PROJECTION_RELAY_MAX_BYTES,
  __resetRuntimeProjectionRelayForTests,
  __setRuntimeProjectionStateReaderForTests,
  scheduleRuntimeProjectionPush,
  shedProjectionToFit,
} from '../runtime-projection-relay'
import { resetRuntimeStateForTests } from '../runtime-state-projection'

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
  setEnv(BASE_ENV)
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
  __resetRuntimeProjectionRelayForTests()
})

describe('scheduleRuntimeProjectionPush', () => {
  test('POSTs the gzipped projection to /v1/platform/runtime-projection with a bearer token', async () => {
    const doc = makeDoc()
    __setRuntimeProjectionStateReaderForTests(readerFor(doc, 'etag-1'))
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{"ok":true,"stored":"stored","etag":"etag-1"}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.kortix.test/v1/platform/runtime-projection')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sandbox-token-abc')
    expect(headers['Content-Encoding']).toBe('gzip')
    expect(headers['Content-Type']).toBe('application/json')
    const body = decompress(call.init.body)
    expect(body.session_id).toBe('sess-1')
    expect(body.captured_at).toBe('2026-08-27T00:00:00.000Z')
    expect(body.projection_etag).toBe('etag-1')
    expect(body.projection).toEqual(doc as never)
  })

  test('does not double the /v1 prefix when KORTIX_API_URL already ends in /v1', async () => {
    setEnv({ ...BASE_ENV, KORTIX_API_URL: 'https://api.kortix.test/v1/' })
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toEqual(['https://api.kortix.test/v1/platform/runtime-projection'])
  })

  test('is a silent no-op when KORTIX_API_URL is unset', async () => {
    setEnv({ ...BASE_ENV, KORTIX_API_URL: undefined })
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toEqual([])
  })

  test('is a silent no-op when no credential is configured', async () => {
    setEnv({ ...BASE_ENV, KORTIX_TOKEN: undefined })
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    scheduleRuntimeProjectionPush('boot')
    await settle()

    expect(urls).toEqual([])
  })

  test('is a silent no-op when no runtime state store is configured (default reader, cold boot)', async () => {
    // No __setRuntimeProjectionStateReaderForTests: the default reader consults
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
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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
    __setRuntimeProjectionStateReaderForTests(async () => ({ doc: makeDoc() as never, etag }))
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

  test('never throws and never blocks the caller, even when fetch rejects', async () => {
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
    globalThis.fetch = (async () => {
      throw new Error('network unreachable')
    }) as unknown as typeof fetch

    const started = Date.now()
    expect(() => scheduleRuntimeProjectionPush('boot')).not.toThrow()
    expect(Date.now() - started).toBeLessThan(50)
    await settle()
  })

  test('a failed push does not poison etag suppression — the next trigger retries', async () => {
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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

  test('503 retries are bounded — a permanently unavailable API is abandoned', async () => {
    __setRuntimeProjectionStateReaderForTests(readerFor(makeDoc(), 'etag-1'))
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
  test('returns the document unchanged when it already fits', () => {
    const doc = makeDoc()
    const { projection, shed } = shedProjectionToFit(doc as never, PROJECTION_RELAY_MAX_BYTES)
    expect(shed).toEqual([])
    expect(projection).toEqual(doc as never)
  })

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
  test('a real HTTP sink receives the push, gunzips it, and the relay records success', async () => {
    const received: { auth: string | null; encoding: string | null; body: Record<string, unknown> }[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const raw = Buffer.from(await req.arrayBuffer())
        received.push({
          auth: req.headers.get('authorization'),
          encoding: req.headers.get('content-encoding'),
          body: JSON.parse(gunzipSync(raw).toString('utf8')) as Record<string, unknown>,
        })
        return Response.json({ ok: true, stored: 'stored', etag: 'etag-real' })
      },
    })
    try {
      setEnv({ ...BASE_ENV, KORTIX_API_URL: `http://127.0.0.1:${server.port}` })
      const doc = makeDoc()
      __setRuntimeProjectionStateReaderForTests(readerFor(doc, 'etag-real'))

      scheduleRuntimeProjectionPush('boot')
      await settle(100)

      expect(received.length).toBe(1)
      expect(received[0]!.auth).toBe('Bearer sandbox-token-abc')
      expect(received[0]!.encoding).toBe('gzip')
      expect(received[0]!.body.session_id).toBe('sess-1')
      expect(received[0]!.body.projection).toEqual(doc as never)

      // And the landed etag now suppresses a repeat.
      scheduleRuntimeProjectionPush('boot')
      await settle(100)
      expect(received.length).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})

describe('wiring', () => {
  // The relay is only worth anything if the daemon actually calls it. Pin the
  // four call sites so a refactor cannot silently drop the push.
  const main = new TextDecoder().decode(
    new Uint8Array(require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '..', 'main.ts'))),
  )
  const envRoute = require('node:fs').readFileSync(
    require('node:path').join(import.meta.dir, '..', 'routes', 'env.ts'),
    'utf8',
  ) as string

  test('main.ts pushes on both runtime-ready exits', () => {
    const bootPushes = main.split("scheduleRuntimeProjectionPush('boot')").length - 1
    expect(bootPushes).toBe(2)
  })

  test('main.ts pushes on the catalog-moving SSE frames', () => {
    expect(main).toContain("event.type === 'server.instance.disposed'")
    expect(main).toContain("event.type === 'mcp.tools.changed'")
    expect(main).toContain("event.type === 'plugin.added'")
    expect(main).toContain('scheduleRuntimeProjectionPush(event.type)')
  })

  test('routes/env.ts pushes after the daemon rewrites config', () => {
    expect(envRoute).toContain("scheduleRuntimeProjectionPush('kortix-env-applied')")
  })
})
