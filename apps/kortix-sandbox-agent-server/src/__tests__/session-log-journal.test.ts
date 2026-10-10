/**
 * The session-log journal (P2.4) against a fake adapter and a fake API.
 *
 * The real `SessionLogJournal` drives the real `SessionLogPort` shape; the fake
 * adapter keeps a native store of rendered messages, and the fake API is a
 * `Bun.serve` that gunzips each journal body. Covered: batching, the hash
 * guard, the 404 and 409 fallbacks, back-off on 503, 5xx and network errors,
 * the 3 s bound before the turn-end relay, and the flush on the daemon's stop.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import type {
  AdapterCapabilities,
  ExportCursor,
  SessionLog,
  SessionLogJournalRequest,
  SessionLogMessage,
} from '@kortix/api-contract/session-log'
import { installShutdownHandlers } from '@/app/shutdown'
import type { SessionLogChanges, SessionLogPort } from '@/harness/contract/session-log'
import {
  JOURNAL_MAX_BATCH_BYTES,
  SessionLogJournal,
  resetSessionLogJournalForTests,
  startSessionLogJournal,
} from '@/harness/shared/session-log-journal'
import { relayTurnEnd } from '@/harness/shared/turn-relay'
import { resetDaemonShutdownStateForTests } from '@/lib/shutdown-state'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'

const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const
let saved: Record<string, string | undefined> = {}
const servers: Array<{ stop(closeActive?: boolean): void }> = []

beforeEach(() => {
  resetSessionLogJournalForTests()
  resetDaemonShutdownStateForTests()
  resetSessionTokenHealthForTests()
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  process.env.KORTIX_PROJECT_ID = 'project-1'
  process.env.KORTIX_SESSION_ID = 'session-1'
  process.env.KORTIX_TOKEN = 'session-token'
})

afterEach(() => {
  resetSessionLogJournalForTests()
  resetDaemonShutdownStateForTests()
  resetSessionTokenHealthForTests()
  for (const s of servers.splice(0)) s.stop(true)
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ── Fakes ─────────────────────────────────────────────────────────────────

const FEATURES = {
  tool_error_channel: true,
  attachments: { user: [], tool_result: false },
  compaction: [],
  subagents: 'none',
  todos: false,
  reasoning_replay: 'none',
  freeform_tool_input: false,
} satisfies AdapterCapabilities['native']
const CAPABILITIES: AdapterCapabilities = {
  harness: 'fake',
  harness_versions: '*',
  schema_minors: [1],
  dialects: [],
  native: FEATURES,
  rendered: FEATURES,
}

function message(id: string, seq: number, text: string): SessionLogMessage {
  return {
    schema: 'kortix.session/2',
    v: 1,
    message_id: id,
    thread_id: 'thr_root',
    seq,
    role: 'assistant',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    model: { provider: 'fake', model: 'fake-1' },
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    finish: 'stop',
    error: null,
    created_at: '2026-10-11T00:00:00.000Z',
    completed_at: '2026-10-11T00:00:01.000Z',
    producer: { harness: 'fake', harness_version: '0', adapter_version: '1' },
    blocks: [{ type: 'text', id: `${id}-b1`, text }],
  }
}

const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/**
 * A harness whose native store keeps only the model-visible text of each
 * message: re-deriving a record from it loses `model` and `usage` (a lossy
 * store). `changes` returns every message every time, the worst case the
 * journal's hash guard must absorb.
 */
function fakeAdapter() {
  const native = new Map<string, { seq: number; text: string }>()
  const removed: string[] = []
  let session: SessionLogChanges['session']
  const derive = (id: string, row: { seq: number; text: string }): SessionLogMessage => ({
    ...message(id, row.seq, row.text),
    model: null,
    usage: null,
  })
  const port: SessionLogPort = {
    capabilities: CAPABILITIES,
    async changes() {
      const out: SessionLogChanges = {
        messages: [...native].map(([id, row]) => ({ message: derive(id, row), native_hash: sha(row.text) })),
        tombstones: removed.splice(0),
        threads: [{ schema: 'kortix.session/2', v: 1, thread_id: 'thr_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '2026-10-11T00:00:00.000Z' }],
        ...(session ? { session } : {}),
      }
      session = undefined
      return out
    },
    async restore(log: SessionLog) {
      const cursors: ExportCursor[] = []
      for (const thread of log.threads) {
        const cursor: ExportCursor = { thread_id: thread.thread_id, last_seq: -1, native_hashes: {} }
        for (const m of thread.messages) {
          const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
          native.set(m.message_id, { seq: m.seq, text })
          cursor.native_hashes[m.message_id] = sha(text)
          cursor.last_seq = Math.max(cursor.last_seq, m.seq)
        }
        cursors.push(cursor)
      }
      return cursors
    },
    async fingerprint() {
      return sha(JSON.stringify([...native]))
    },
  }
  return {
    port,
    put: (id: string, seq: number, text: string) => native.set(id, { seq, text }),
    remove: (id: string) => {
      native.delete(id)
      removed.push(id)
    },
    setSession: (patch: SessionLogChanges['session']) => {
      session = patch
    },
  }
}

interface Received {
  body: SessionLogJournalRequest
  gzippedBytes: number
  at: number
  path: string
  headers: Headers
}

const ack = (body: SessionLogJournalRequest) =>
  Response.json({
    acked: [...body.puts.map((p) => ({ message_id: p.message.message_id, rev: p.rev })), ...body.tombstones],
  })

/** The fake API. `journal` answers the n-th journal POST (1-based); the turn stream always settles. */
function fakeApi(journal: (body: SessionLogJournalRequest, n: number) => Response | Promise<Response> = ack, port = 0) {
  const received: Received[] = []
  const turnEnds: number[] = []
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/turn-stream')) {
        const body = (await request.json()) as { kind?: string }
        if (body.kind === 'end') turnEnds.push(performance.now())
        return Response.json({ ok: true })
      }
      const raw = new Uint8Array(await request.arrayBuffer())
      const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))) as SessionLogJournalRequest
      received.push({ body, gzippedBytes: raw.byteLength, at: performance.now(), path: url.pathname, headers: request.headers })
      return journal(body, received.length)
    },
  })
  servers.push(server)
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
  return { received, turnEnds, port: server.port }
}

const putIds = (r: Received[]) => r.flatMap((x) => x.body.puts.map((p) => `${p.message.message_id}@${p.rev}`))

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('session-log journal', () => {
  test('a flush posts the new messages, threads and session patch, gzipped, with the sandbox token and the generation', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'hello')
    fake.put('m2', 2, 'world')
    fake.setSession({ title: 'A synthetic title' })
    const journal = new SessionLogJournal(fake.port, { generation: 7 })

    expect(await journal.flush()).toBe(true)

    expect(api.received).toHaveLength(1)
    const [first] = api.received
    expect(first!.path).toBe('/v1/projects/project-1/sessions/session-1/log/journal')
    expect(first!.headers.get('authorization')).toBe('Bearer session-token')
    expect(first!.headers.get('content-encoding')).toBe('gzip')
    expect(first!.body.generation).toBe(7)
    expect(putIds(api.received)).toEqual(['m1@1', 'm2@1'])
    expect(first!.body.threads.map((t) => t.thread_id)).toEqual(['thr_root'])
    expect(first!.body.session).toEqual({ title: 'A synthetic title' })
    expect(journal.clean).toBe(true)
  })

  test('a dirty set over 1 MB gzipped goes in several batches of at most 1 MB, in order', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    // ~100 kB of base64 per message, about 76 kB gzipped: 40 messages are ~3 MB gzipped.
    const ids = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    ids.forEach((id, i) => fake.put(id, i, randomBytes(75_000).toString('base64')))
    const journal = new SessionLogJournal(fake.port, { generation: 1 })

    expect(await journal.flush(10_000)).toBe(true)

    expect(api.received.length).toBeGreaterThanOrEqual(3)
    for (const r of api.received) expect(r.gzippedBytes).toBeLessThanOrEqual(JOURNAL_MAX_BATCH_BYTES)
    expect(putIds(api.received)).toEqual(ids.map((id) => `${id}@1`))
    // Threads ride in the first batch only.
    expect(api.received.map((r) => r.body.threads.length)).toEqual([1, ...api.received.slice(1).map(() => 0)])
  })

  test('hash guard: unchanged messages are not sent again, a changed one is, with the next rev', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    fake.put('m2', 2, 'two')
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    expect(putIds(api.received)).toEqual(['m1@1', 'm2@1'])

    // Nothing changed in the native store: only the thread upsert goes.
    expect(await journal.flush()).toBe(true)
    expect(putIds(api.received)).toEqual(['m1@1', 'm2@1'])

    fake.put('m2', 2, 'two, edited')
    fake.remove('m1')
    expect(await journal.flush()).toBe(true)
    const last = api.received.at(-1)!.body
    expect(last.puts.map((p) => `${p.message.message_id}@${p.rev}`)).toEqual(['m2@2'])
    expect(last.puts[0]!.message.blocks).toEqual([{ type: 'text', id: 'm2-b1', text: 'two, edited' }])
    expect(last.tombstones).toEqual([{ message_id: 'm1', rev: 2 }])
  })

  test('hash guard: a restored record is not re-derived from the lossy native store', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    const restored = message('r1', 1, 'restored')
    const log: SessionLog = {
      schema: 'kortix.session/2',
      v: 1,
      session_id: 'session-1',
      title: null,
      created_at: '2026-10-11T00:00:00.000Z',
      restore_grade: 'native',
      harness: { current: 'fake', history: [] },
      selection: { agent: null, model: null },
      todos: [],
      pending: { questions: [], permissions: [] },
      threads: [{ schema: 'kortix.session/2', v: 1, thread_id: 'thr_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '2026-10-11T00:00:00.000Z', messages: [restored] }],
    }
    const cursors = await fake.port.restore(log)
    fake.put('n1', 2, 'new after restore')
    const journal = new SessionLogJournal(fake.port, { generation: 2, cursors })

    expect(await journal.flush()).toBe(true)

    // The adapter re-derived r1 without `model` and `usage`; the journal kept it off the wire.
    expect(putIds(api.received)).toEqual(['n1@1'])
  })

  test('a 404 turns the journal off for this boot after one request', async () => {
    const api = fakeApi(() => new Response('not found', { status: 404 }))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 10 })

    expect(await journal.flush()).toBe(false)
    expect(journal.disabled).toBe('404')
    fake.put('m2', 2, 'two')
    expect(await journal.flush()).toBe(false)
    await Bun.sleep(100)

    expect(api.received).toHaveLength(1)
  })

  test('a 409 fences a zombie box: the journal stops for this boot', async () => {
    const api = fakeApi(() => Response.json({ generation: 4 }, { status: 409 }))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 3, retryMs: 10 })

    expect(await journal.flush()).toBe(false)
    expect(journal.disabled).toBe('409')
    fake.put('m2', 2, 'two')
    await journal.flush()
    await Bun.sleep(100)

    expect(api.received).toHaveLength(1)
    expect(api.received[0]!.body.generation).toBe(3)
  })

  test('a 503 backs off with a growing delay and keeps the dirty set until it is acknowledged', async () => {
    const api = fakeApi((body, n) => (n <= 2 ? new Response('journal off', { status: 503 }) : ack(body)))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 100 })

    // The operator switch is off: the flush returns at the first 503, it does not wait 3 s.
    const started = performance.now()
    expect(await journal.flush()).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
    // A flush while backing off collects and returns at once.
    expect(await journal.flush()).toBe(false)

    await until(() => journal.clean, 5_000)
    expect(api.received).toHaveLength(3)
    expect(putIds(api.received)).toEqual(['m1@1', 'm1@1', 'm1@1'])
    const [a, b, c] = api.received.map((r) => r.at)
    // computeRetryDelay: 100 ms then 200 ms, each jittered by +/-25%.
    expect(b! - a!).toBeGreaterThanOrEqual(70)
    expect(c! - b!).toBeGreaterThanOrEqual(145)
    expect(journal.clean).toBe(true)
  })

  test('a 500 and a network error are retried with backoff until the API answers', async () => {
    // Reserve a port, then free it: the first attempt is refused.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)
    process.env.KORTIX_API_URL = `http://127.0.0.1:${port}`
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 200 })

    expect(await journal.flush()).toBe(false)
    const api = fakeApi((body, n) => (n === 1 ? new Response('boom', { status: 500 }) : ack(body)), port)

    await until(() => journal.clean, 5_000)
    expect(putIds(api.received)).toEqual(['m1@1', 'm1@1'])
    const [a, b] = api.received.map((r) => r.at)
    // The 500 is the second failure: 400 ms, jittered by +/-25%.
    expect(b! - a!).toBeGreaterThanOrEqual(290)
  })

  test('another 4xx drops the batch instead of retrying it forever; later changes still go', async () => {
    const api = fakeApi((body, n) => (n === 1 ? new Response('bad batch', { status: 400 }) : ack(body)))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 10 })

    expect(await journal.flush()).toBe(true)
    expect(api.received).toHaveLength(1)
    fake.put('m2', 2, 'two')
    expect(await journal.flush()).toBe(true)

    expect(putIds(api.received)).toEqual(['m1@1', 'm2@1'])
  })

  test('a slow acknowledgement holds the turn-end relay at most 3 s; the batch is retried afterwards', async () => {
    const api = fakeApi(async (body, n) => {
      if (n === 1) {
        await Bun.sleep(4_000)
        return new Response('slow and failed', { status: 503 })
      }
      return ack(body)
    })
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = startSessionLogJournal(fake.port, { generation: 1, retryMs: 100 })
    if (!journal) throw new Error('journal did not start')

    const started = performance.now()
    expect(await relayTurnEnd({ runtimeSessionId: 'ses_root', messageId: 'msg_user', status: 'idle' })).toBe(true)

    expect(api.turnEnds).toHaveLength(1)
    const held = api.turnEnds[0]! - started
    expect(held).toBeGreaterThanOrEqual(2_900)
    expect(held).toBeLessThan(3_600)
    expect(journal.clean).toBe(false)

    await until(() => journal.clean, 5_000)
    expect(putIds(api.received)).toEqual(['m1@1', 'm1@1'])
  }, 15_000)

  test('the daemon stop flushes the journal before the harness stops and the process exits', async () => {
    const order: string[] = []
    fakeApi((body) => {
      order.push(`journal ${body.puts.map((p) => p.message.message_id).join(',')}`)
      return ack(body)
    })
    const fake = fakeAdapter()
    fake.put('m1', 1, 'last words')
    const journal = startSessionLogJournal(fake.port, { generation: 1 })
    if (!journal) throw new Error('journal did not start')
    const proxy = { port: 0, reload: () => {}, stop: async () => {} }
    const harness = { stop: async () => void order.push('harness.stop') }
    const shutdown = installShutdownHandlers(harness, proxy, undefined, { exit: (code) => void order.push(`exit ${code}`) })

    shutdown({ reason: 'agent-swap', exitCode: 75 })
    await until(() => order.includes('exit 75'))

    expect(order).toEqual(['journal m1', 'harness.stop', 'exit 75'])
    expect(journal.clean).toBe(true)
  })

  test('a stop with an unreachable API exits within the 3 s bound and sends nothing more', async () => {
    let calls = 0
    fakeApi(async () => {
      calls += 1
      await Bun.sleep(10_000)
      return new Response('', { status: 503 })
    })
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    startSessionLogJournal(fake.port, { generation: 1, retryMs: 10 })
    const exits: number[] = []
    const shutdown = installShutdownHandlers({ stop: async () => {} }, { port: 0, reload: () => {}, stop: async () => {} }, undefined, {
      exit: (code) => void exits.push(code),
    })

    const started = performance.now()
    shutdown({ reason: 'SIGTERM', exitCode: 0 })
    await until(() => exits.length > 0, 5_000)

    expect(performance.now() - started).toBeLessThan(3_600)
    expect(calls).toBe(1)
  }, 15_000)

  test('no control plane: the journal does not start, and the turn-end flush is a no-op', async () => {
    delete process.env.KORTIX_API_URL
    expect(startSessionLogJournal(fakeAdapter().port, { generation: 1 })).toBeNull()
  })
})
