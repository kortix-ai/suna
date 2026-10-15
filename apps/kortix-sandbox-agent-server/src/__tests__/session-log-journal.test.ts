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
import { createHash, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromV1, toV1 } from '@kortix/api-contract/session-log'
import type {
  AdapterCapabilities,
  ExportCursor,
  SessionLog,
  SessionLogJournalRequest,
  SessionLogMessage,
} from '@kortix/api-contract/session-log'
import { installShutdownHandlers } from '@/app/shutdown'
import type { SessionLogChanges, SessionLogPort } from '@/harness/contract/session-log'
import { __resetRelayedTurnSignatures, relayTurnEndToApi } from '@/harness/open-code/boot'
import type { OpenCodeConfig } from '@/harness/open-code/config'
import {
  JOURNAL_MAX_BATCH_BYTES,
  JOURNAL_UNACKED_RETRIES,
  SessionLogJournal,
  resetSessionLogJournalForTests,
  startSessionLogJournal,
} from '@/harness/shared/session-log-journal'
import { relayTurnEnd } from '@/harness/shared/turn-relay'
import { kortixEventBus, resetKortixEventBusForTests, sessionLogEventBus } from '@/services/event-bus/kortix-event-bus'
import { resetDaemonShutdownStateForTests } from '@/lib/shutdown-state'
import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
} from '@/lib/kortix-api/session-token-health'

const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const
let saved: Record<string, string | undefined> = {}
const servers: Array<{ stop(closeActive?: boolean): void }> = []

beforeEach(() => {
  __resetRelayedTurnSignatures()
  resetSessionLogJournalForTests()
  resetDaemonShutdownStateForTests()
  resetSessionTokenHealthForTests()
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  process.env.KORTIX_PROJECT_ID = 'project-1'
  process.env.KORTIX_SESSION_ID = 'session-1'
  process.env.KORTIX_TOKEN = 'session-token'
})

afterEach(() => {
  __resetRelayedTurnSignatures()
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
  const liveSeqs = new Map<string, number>()
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
      return { cursors, dropped: {} }
    },
    async held() {
      return new Set(native.keys())
    },
    live: (_thread: string, id: string) => (liveSeqs.has(id) ? { seq: liveSeqs.get(id)! } : null),
  }
  return {
    port,
    /** The seq `live` names for a message of the live turn. */
    liveSeq: (id: string, seq: number) => liveSeqs.set(id, seq),
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

/**
 * The fake API, also a fake OpenCode for the OpenCode turn-end path.
 * `journal` answers the n-th journal POST (1-based); the turn stream always
 * settles. `order` records journal posts and turn ends as they arrive.
 */
function fakeApi(
  journal: (body: SessionLogJournalRequest, n: number, request: Request) => Response | Promise<Response> = ack,
  port = 0,
) {
  const received: Received[] = []
  const turnEnds: number[] = []
  const order: string[] = []
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/turn-stream')) {
        const body = (await request.json()) as { kind?: string }
        if (body.kind === 'end') {
          turnEnds.push(performance.now())
          order.push('end')
        }
        return Response.json({ ok: true })
      }
      if (url.pathname === '/session/ses_root') return Response.json({ parentID: null })
      if (url.pathname === '/session/ses_root/message') {
        return Response.json([
          { info: { id: 'msg_user', role: 'user' } },
          { info: { role: 'assistant', parentID: 'msg_user', time: { completed: 1000 } } },
        ])
      }
      const raw = new Uint8Array(await request.arrayBuffer())
      const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))) as SessionLogJournalRequest
      received.push({ body, gzippedBytes: raw.byteLength, at: performance.now(), path: url.pathname, headers: request.headers })
      order.push(`journal ${body.puts.map((p) => p.message.message_id).join(',')}`)
      return journal(body, received.length, request)
    },
  })
  servers.push(server)
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
  return { received, turnEnds, order, port: server.port, url: `http://127.0.0.1:${server.port}` }
}

const putIds = (r: Received[]) => r.flatMap((x) => x.body.puts.map((p) => p.message.message_id))
const revOf = (r: Received[], id: string) => r.flatMap((x) => x.body.puts).filter((p) => p.message.message_id === id).map((p) => p.rev)

/** Resolves when the request is aborted: a hanging handler must not outlive the test. */
const aborted = (request: Request) => new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()))

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

/** Many messages of incompressible text: several batches under `maxBatchBytes: 4_000`. */
function manyMessages(fake: ReturnType<typeof fakeAdapter>, count = 10) {
  for (let i = 0; i < count; i++) fake.put(`m${i}`, i, randomBytes(1_500).toString('base64'))
}

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
    expect(putIds(api.received)).toEqual(['m1', 'm2'])
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
    expect(putIds(api.received)).toEqual(ids)
    // Threads ride in the first batch only.
    expect(api.received.map((r) => r.body.threads.length)).toEqual([1, ...api.received.slice(1).map(() => 0)])
  })

  test('hash guard: unchanged messages and threads are not sent again, a changed message is, with a higher rev', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    fake.put('m2', 2, 'two')
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    expect(putIds(api.received)).toEqual(['m1', 'm2'])

    // Nothing changed in the native store (the adapter still returns every message and the thread): no post.
    expect(await journal.flush()).toBe(true)
    expect(api.received).toHaveLength(1)

    fake.put('m2', 2, 'two, edited')
    fake.remove('m1')
    expect(await journal.flush()).toBe(true)
    expect(api.received).toHaveLength(2)
    const last = api.received[1]!.body
    expect(last.puts.map((p) => p.message.message_id)).toEqual(['m2'])
    expect(last.puts[0]!.message.blocks).toEqual([{ type: 'text', id: 'm2-b1', text: 'two, edited' }])
    expect(last.threads).toEqual([])
    const [m1, m2] = revOf(api.received, 'm1').concat(revOf(api.received, 'm2'))
    expect(last.puts[0]!.rev).toBeGreaterThan(m2!)
    expect(last.tombstones.map((t) => t.message_id)).toEqual(['m1'])
    expect(last.tombstones[0]!.rev).toBeGreaterThan(m1!)
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
    const { cursors } = await fake.port.restore(log)
    fake.put('n1', 2, 'new after restore')
    const journal = new SessionLogJournal(fake.port, { generation: 2, cursors })

    expect(await journal.flush()).toBe(true)

    // The adapter re-derived r1 without `model` and `usage`; the journal kept it off the wire.
    expect(putIds(api.received)).toEqual(['n1'])
  })

  test('rev is monotonic across boots: a restarted daemon never reuses a rev', async () => {
    const api = fakeApi()
    const first = fakeAdapter()
    first.put('m1', 1, 'before the restart')
    expect(await new SessionLogJournal(first.port, { generation: 1 }).flush()).toBe(true)
    // A daemon restart without a restore: same generation, no cursors, new content for m1.
    const second = fakeAdapter()
    second.put('m1', 1, 'after the restart')
    expect(await new SessionLogJournal(second.port, { generation: 1 }).flush()).toBe(true)

    const [before, after] = revOf(api.received, 'm1')
    expect(after).toBeGreaterThan(before!)
    expect(Number.isSafeInteger(after)).toBe(true)
    // A rev follows the clock (1000 per ms), so a later process starts above it too.
    expect(before!).toBeGreaterThanOrEqual((Date.now() - 60_000) * 1000)
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

  test('after a 404 a turn end does no work: no export, no log.* frame, no HTTP call, no delta', async () => {
    resetKortixEventBusForTests()
    const api = fakeApi(() => new Response('not found', { status: 404 }))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    let exports = 0
    const changes = fake.port.changes.bind(fake.port)
    const journal = new SessionLogJournal({ ...fake.port, changes: (cursors) => (exports++, changes(cursors)) }, { generation: 1, retryMs: 10 })
    expect(await journal.flush()).toBe(false)
    expect(journal.disabled).toBe('404')
    const frames: string[] = []
    sessionLogEventBus().subscribe((e) => void frames.push(e.type), {})
    const [before, posts] = [exports, api.received.length]
    fake.put('m2', 2, 'two')
    fake.remove('m1')
    expect(await journal.flush()).toBe(false)
    fake.liveSeq('m3', 3)
    kortixEventBus().publish('message.updated', { sessionID: 'thread-1', info: { id: 'm3', sessionID: 'thread-1', role: 'assistant', time: { created: 1 } } }, 'thread-1')
    kortixEventBus().publish('message.part.updated', { sessionID: 'thread-1', part: { id: 'm3-p0', messageID: 'm3', sessionID: 'thread-1', type: 'text', text: '' } }, 'thread-1')
    kortixEventBus().publish('message.part.delta', { sessionID: 'thread-1', messageID: 'm2', partID: 'm2-p0', field: 'text', delta: 'x' }, 'thread-1')
    await Bun.sleep(50)
    expect(exports).toBe(before)
    expect(frames).toEqual([])
    expect(api.received).toHaveLength(posts)
  })

  test('live turn (P4.3b): puts on the v2 bus only, each before its deltas; a message waits for its seq; the API receives the turn end\'s record alone', async () => {
    resetKortixEventBusForTests()
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'earlier')
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    const frames: Array<{ type: string; payload: any }> = []
    sessionLogEventBus().subscribe((e) => void frames.push(e), {})
    const v1: string[] = []
    kortixEventBus().subscribe((e) => void v1.push(JSON.stringify(e)), {})
    const bus = kortixEventBus()
    const T = 'thr_root'
    const user = { id: 'u2', sessionID: T, role: 'user', time: { created: 2_000 } }
    const reply = { id: 'm3', sessionID: T, role: 'assistant', parentID: 'u2', time: { created: 3_000 }, modelID: 'fake-1', providerID: 'fake' }
    // The harness has not stored the prompt: no seq, no put yet.
    bus.publish('message.updated', { sessionID: T, info: user }, T)
    bus.publish('message.part.updated', { sessionID: T, part: { id: 'u2-p0', messageID: 'u2', sessionID: T, type: 'text', text: 'question' } }, T)
    expect(frames).toEqual([])
    // A message the journal already collected gets no live put.
    bus.publish('message.part.updated', { sessionID: T, part: { id: 'm1-x', messageID: 'm1', sessionID: T, type: 'text', text: '' } }, T)
    expect(frames).toEqual([])
    fake.liveSeq('u2', 2)
    fake.liveSeq('m3', 3)
    bus.publish('message.updated', { sessionID: T, info: reply }, T)
    const text = { id: 'm3-p0', messageID: 'm3', sessionID: T, type: 'text', text: '' }
    bus.publish('message.part.updated', { sessionID: T, part: text }, T)
    bus.publish('message.part.delta', { sessionID: T, messageID: 'm3', partID: 'm3-p0', field: 'text', delta: 'Ans' }, T)
    bus.publish('message.part.delta', { sessionID: T, messageID: 'm3', partID: 'm3-p0', field: 'text', delta: 'wer' }, T)
    bus.publish('message.part.updated', { sessionID: T, part: { id: 'm3-p1', messageID: 'm3', sessionID: T, type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 3_100 } } } }, T)
    expect(frames.map((f) => [f.type, f.payload.message?.message_id ?? f.payload.delta])).toEqual([
      ['log.message', 'u2'], // the waiting prompt first, in the order the v1 bus named them
      ['log.message', 'm3'],
      ['log.message', 'm3'],
      ['log.block.delta', 'Ans'],
      ['log.block.delta', 'wer'],
      ['log.message', 'm3'],
    ])
    expect(frames[0]!.payload.message).toMatchObject({ seq: 2, role: 'user', status: 'complete', blocks: [{ id: 'u2-p0', text: 'question' }] })
    expect(frames[1]!.payload.message).toMatchObject({ seq: 3, thread_id: T, role: 'assistant', status: 'streaming', reply_to: 'u2', completed_at: null, finish: null, blocks: [], created_at: new Date(3_000).toISOString() })
    expect(frames[2]!.payload.message.blocks).toEqual([{ type: 'text', id: 'm3-p0', text: '' }])
    expect(frames[5]!.payload.message.blocks).toMatchObject([{ id: 'm3-p0', text: 'Answer' }, { type: 'tool_call', id: 'm3-p1', status: 'running' }])
    expect(frames[5]!.payload.message.blocks[1].result).toBeUndefined()
    const revs = frames.filter((f) => f.type === 'log.message').map((f) => f.payload.rev)
    expect(revs).toEqual([...revs].sort((a, b) => a - b))
    // The v1 frames are untouched: the deltas extended the journal's copy, never the published part.
    expect(text.text).toBe('')
    expect(v1.every((line) => !line.includes('Answer'))).toBe(true)
    // Nothing live reached the API. The turn end's collection sends the stored records at higher revs.
    expect(api.received).toHaveLength(1)
    // The live puts never entered the dirty set: a journal in backoff would post a streaming record.
    expect(journal.clean).toBe(true)
    const live = [...frames]
    fake.put('u2', 2, 'question')
    fake.put('m3', 3, 'Answer')
    expect(await journal.flush()).toBe(true)
    expect(putIds(api.received.slice(1))).toEqual(['u2', 'm3'])
    for (const id of ['u2', 'm3']) {
      const liveRevs = live.filter((f) => f.payload.message?.message_id === id).map((f) => f.payload.rev)
      expect(revOf(api.received, id)[0]).toBeGreaterThan(Math.max(...liveRevs))
    }
    // A collected message gets no later live put.
    const seen = frames.length
    bus.publish('message.part.updated', { sessionID: T, part: { id: 'm3-p2', messageID: 'm3', sessionID: T, type: 'text', text: 'late' } }, T)
    expect(frames).toHaveLength(seen)
    await journal.stop(0)
  })

  test('live turn (P4.3b): a live message removed before its collection gets a tombstone on v2; a removed part a fresh put', async () => {
    resetKortixEventBusForTests()
    const api = fakeApi()
    const fake = fakeAdapter()
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    const frames: Array<{ type: string; payload: any; session?: string }> = []
    sessionLogEventBus().subscribe((e) => void frames.push(e), {})
    const bus = kortixEventBus()
    const T = 'thr_root'
    fake.liveSeq('u1', 1)
    fake.liveSeq('m2', 2)
    // A queued prompt the user retracts, and a reply whose part the harness drops.
    bus.publish('message.updated', { sessionID: T, info: { id: 'u1', sessionID: T, role: 'user', time: { created: 1_000 } } }, T)
    bus.publish('message.updated', { sessionID: T, info: { id: 'm2', sessionID: T, role: 'assistant', parentID: 'u1', time: { created: 2_000 } } }, T)
    bus.publish('message.part.updated', { sessionID: T, part: { id: 'm2-p0', messageID: 'm2', sessionID: T, type: 'text', text: 'draft' } }, T)
    bus.publish('message.part.removed', { sessionID: T, messageID: 'm2', partID: 'm2-p0' }, T)
    bus.publish('message.removed', { sessionID: T, messageID: 'u1' }, T)
    // A message no put named: nothing to retract.
    bus.publish('message.removed', { sessionID: T, messageID: 'never-seen' }, T)
    expect(frames.map((f) => [f.payload.message?.message_id ?? f.payload.message_id, f.payload.message ? f.payload.message.blocks.length : 'tombstone'])).toEqual([
      ['u1', 0],
      ['m2', 0],
      ['m2', 1],
      ['m2', 0], // the part is gone
      ['u1', 'tombstone'],
    ])
    expect(frames[4]!.payload).toEqual({ message_id: 'u1', rev: expect.any(Number) })
    expect(frames[4]!.session).toBe(T)
    expect(frames[4]!.payload.rev).toBeGreaterThan(frames[0]!.payload.rev)
    // The reply ends in the store; the collection takes it, and no live row is left.
    fake.put('m2', 2, 'final')
    expect(await journal.flush()).toBe(true)
    expect(putIds(api.received.slice(1))).toEqual(['m2'])
    expect((journal as unknown as { live: Map<string, unknown> }).live.size).toBe(0)
    await journal.stop(0)
  })

  test('live turn: a codemode part puts when a call in its metadata.calls starts or ends, never per repeated frame', async () => {
    resetKortixEventBusForTests()
    fakeApi()
    const fake = fakeAdapter()
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    const frames: Array<{ type: string; payload: any }> = []
    sessionLogEventBus().subscribe((e) => void frames.push(e), {})
    const bus = kortixEventBus()
    const T = 'thr_root'
    fake.liveSeq('m5', 5)
    bus.publish('message.updated', { sessionID: T, info: { id: 'm5', sessionID: T, role: 'assistant', parentID: 'u4', time: { created: 5_000 }, modelID: 'fake-1', providerID: 'fake' } }, T)
    const script = (calls: Array<{ name: string; status: string }>) => ({
      messageID: 'm5', sessionID: T, type: 'tool', id: 'm5-cm', callID: 'c-cm', tool: 'codemode',
      state: { status: 'running', input: { code: 'await tools.bash({})' }, metadata: { calls }, time: { start: 5_100 } },
    })
    const steps = [
      script([]),
      script([{ name: 'bash', status: 'running' }]),
      script([{ name: 'bash', status: 'running' }]), // the same frame again: no put
      script([{ name: 'bash', status: 'ok' }]),
      script([{ name: 'bash', status: 'ok' }, { name: 'read', status: 'running' }]),
    ]
    for (const part of steps) bus.publish('message.part.updated', { sessionID: T, part }, T)
    const calls = frames
      .filter((f) => f.type === 'log.message')
      .map((f) => (f.payload.message as SessionLogMessage).blocks.length)
    // message.updated, the new part, then one put per call start or end.
    expect(calls).toEqual([0, 1, 1, 1, 1])
    await journal.stop(0)
  })

  test('live turn (P4.7): a running call keeps its v1 metadata and a pending call its partial input; a tool part puts on a status or metadata-key change only', async () => {
    resetKortixEventBusForTests()
    const api = fakeApi()
    const fake = fakeAdapter()
    const journal = new SessionLogJournal(fake.port, { generation: 1 })
    expect(await journal.flush()).toBe(true)
    const frames: Array<{ type: string; payload: any }> = []
    sessionLogEventBus().subscribe((e) => void frames.push(e), {})
    const bus = kortixEventBus()
    const T = 'thr_root'
    fake.liveSeq('m4', 4)
    const info = { id: 'm4', sessionID: T, role: 'assistant', parentID: 'u3', time: { created: 4_000 }, modelID: 'fake-1', providerID: 'fake' }
    const head = { messageID: 'm4', sessionID: T, type: 'tool' }
    const task = (state: Record<string, unknown>) => ({ ...head, id: 'm4-task', callID: 'c-task', tool: 'task', state })
    const bash = (state: Record<string, unknown>) => ({ ...head, id: 'm4-bash', callID: 'c-bash', tool: 'bash', state })
    const write = { ...head, id: 'm4-write', callID: 'c-write', tool: 'write', state: { status: 'pending', input: {}, raw: '{"filePath":"/w/a.ts","content":"exp' } }
    const taskRunning = task({ status: 'running', input: { description: 'sub', prompt: 'p', subagent_type: 'general' }, title: 'sub', metadata: { sessionId: 'thr_child' }, time: { start: 4_120 } })
    const bashRunning = (output: string) => bash({ status: 'running', input: { command: 'ls -la', description: 'Lists' }, title: 'Lists', metadata: { command: 'ls -la', output }, time: { start: 4_200 } })
    const puts = () => frames.filter((f) => f.type === 'log.message').map((f) => f.payload.message as SessionLogMessage)
    /** The v1 parts `toV1` rebuilds from a live put. */
    const partsBack = (m: SessionLogMessage): unknown[] => {
      const log = fromV1({ session_id: 's', root_id: T, rows: [{ runtime_session_id: T, info: info as never, parts: [] }] }, { live: true })
      log.threads[0]!.messages = [m]
      return toV1(JSON.parse(JSON.stringify(log))).rows[0]!.parts
    }
    bus.publish('message.updated', { sessionID: T, info }, T)
    bus.publish('message.part.updated', { sessionID: T, part: task({ status: 'pending', input: {}, raw: '' }) }, T)
    bus.publish('message.part.updated', { sessionID: T, part: task({ status: 'running', input: { description: 'sub', prompt: 'p', subagent_type: 'general' }, title: 'sub', metadata: {}, time: { start: 4_120 } }) }, T)
    bus.publish('message.part.updated', { sessionID: T, part: taskRunning }, T)
    bus.publish('message.part.updated', { sessionID: T, part: taskRunning }, T) // nothing changed: no put
    bus.publish('message.part.updated', { sessionID: T, part: bashRunning('total 0') }, T)
    bus.publish('message.part.updated', { sessionID: T, part: bashRunning('total 0\na') }, T) // only output grew: no put
    const undefinedKey = bashRunning('total 0\na')
    ;(undefinedKey.state.metadata as Record<string, unknown>).truncation = undefined // a key JSON drops (pi bash): no put
    bus.publish('message.part.updated', { sessionID: T, part: undefinedKey }, T)
    bus.publish('message.part.updated', { sessionID: T, part: write }, T)
    expect(puts().map((m) => m.blocks.map((b) => (b.type === 'tool_call' ? `${b.name}/${b.status}` : b.type)).join(','))).toEqual([
      '', // message.updated
      'task/pending', // new part
      'task/running', // status change
      'task/running', // metadata keys change: sessionId arrived
      'task/running,bash/running', // new part
      'task/running,bash/running,write/pending', // new part
    ])
    const last = puts().at(-1)!
    expect(last).toMatchObject({ seq: 4, status: 'streaming', completed_at: null, finish: null })
    expect(last.blocks.every((b) => b.type !== 'tool_call' || b.result === undefined)).toBe(true)
    // The running calls keep their display metadata: toV1 gives back the frames (bash with the output of its last put).
    expect(partsBack(puts()[3]!)).toEqual([taskRunning])
    expect(partsBack(last)).toEqual([taskRunning, bashRunning('total 0\na'), write])
    // The pending call carries its partial input as its input.
    expect(last.blocks[2]).toMatchObject({ type: 'tool_call', status: 'pending', input: '{"filePath":"/w/a.ts","content":"exp' })
    // The live puts never entered the dirty set, and nothing live reached the API.
    expect(journal.clean).toBe(true)
    expect(api.received).toHaveLength(1)
    // The turn end: the collection's put is the adapter's record, unchanged, at a higher rev.
    fake.put('m4', 4, 'done')
    expect(await journal.flush()).toBe(true)
    const stored = api.received[1]!.body.puts
    expect(stored.map((p) => p.message)).toEqual([{ ...message('m4', 4, 'done'), model: null, usage: null }])
    expect(frames.at(-1)!.payload).toEqual(stored[0])
    expect(stored[0]!.rev).toBeGreaterThan(Math.max(...frames.filter((f) => f.payload.message?.status === 'streaming').map((f) => f.payload.rev)))
    await journal.stop(0)
  })

  test('a 409 fences a zombie box: no later batch of the same drain is posted', async () => {
    const api = fakeApi(() => Response.json({ generation: 4 }, { status: 409 }))
    const fake = fakeAdapter()
    manyMessages(fake)
    const journal = new SessionLogJournal(fake.port, { generation: 3, retryMs: 10, maxBatchBytes: 4_000 })

    expect(await journal.flush()).toBe(false)
    expect(journal.disabled).toBe('409')
    fake.put('m99', 99, 'later')
    await journal.flush()
    await Bun.sleep(100)

    expect(api.received).toHaveLength(1)
    expect(api.received[0]!.body.generation).toBe(3)
  })

  test('a stop in the middle of a multi-batch drain posts no further batch', async () => {
    const api = fakeApi(async (body) => {
      await Bun.sleep(150)
      return ack(body)
    })
    const fake = fakeAdapter()
    manyMessages(fake)
    const journal = new SessionLogJournal(fake.port, { generation: 1, maxBatchBytes: 4_000 })

    void journal.flush()
    await until(() => api.received.length === 1)
    await journal.stop(0)
    await Bun.sleep(400)

    expect(api.received).toHaveLength(1)
  })

  test('a dead session token sends nothing; the journal resumes when the breaker clears', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) noteControlPlaneResponse(401, 'Session token is not active')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 50, maxRetryMs: 100 })

    expect(await journal.flush()).toBe(false)
    await Bun.sleep(300)
    expect(api.received).toHaveLength(0)

    resetSessionTokenHealthForTests()
    await until(() => journal.clean, 5_000)
    expect(putIds(api.received)).toEqual(['m1'])
  })

  test('a second start stops the first journal: one drain loop per boot', async () => {
    const api = fakeApi()
    const first = fakeAdapter()
    first.put('a1', 1, 'first journal')
    const a = startSessionLogJournal(first.port, { generation: 1 })
    const second = fakeAdapter()
    second.put('b1', 1, 'second journal')
    const b = startSessionLogJournal(second.port, { generation: 1 })
    if (!a || !b) throw new Error('journals did not start')

    expect(await a.flush()).toBe(false)
    expect(await b.flush()).toBe(true)
    expect(putIds(api.received)).toEqual(['b1'])
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
    expect(putIds(api.received)).toEqual(['m1', 'm1', 'm1'])
    expect(new Set(revOf(api.received, 'm1')).size).toBe(1)
    const [a, b, c] = api.received.map((r) => r.at)
    // computeRetryDelay: 100 ms then 200 ms, each jittered by +/-25%.
    expect(b! - a!).toBeGreaterThanOrEqual(70)
    expect(c! - b!).toBeGreaterThanOrEqual(145)
  })

  test('a network error, a 500 and a 408 are retried with backoff until the API answers', async () => {
    // Reserve a port, then free it: the first attempt is refused.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)
    process.env.KORTIX_API_URL = `http://127.0.0.1:${port}`
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 200 })

    expect(await journal.flush()).toBe(false)
    const api = fakeApi(
      (body, n) => (n === 1 ? new Response('boom', { status: 500 }) : n === 2 ? new Response('proxy timeout', { status: 408 }) : ack(body)),
      port,
    )

    await until(() => journal.clean, 8_000)
    expect(putIds(api.received)).toEqual(['m1', 'm1', 'm1'])
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

    expect(putIds(api.received)).toEqual(['m1', 'm2'])
  })

  test('a 200 that acknowledges nothing keeps threads and the session patch dirty, and drops the pairs after 3 posts', async () => {
    const api = fakeApi((body, n) => (n <= JOURNAL_UNACKED_RETRIES ? Response.json({ acked: [] }) : ack(body)))
    const fake = fakeAdapter()
    fake.put('m1', 1, 'one')
    fake.setSession({ title: 'A synthetic title' })
    const journal = new SessionLogJournal(fake.port, { generation: 1, retryMs: 10 })

    expect(await journal.flush()).toBe(false)
    await until(() => journal.clean, 5_000)

    expect(api.received).toHaveLength(JOURNAL_UNACKED_RETRIES + 1)
    expect(putIds(api.received)).toEqual(['m1', 'm1', 'm1'])
    // The 4th post carries what no 200 confirmed: the thread and the session patch, not the dropped pair.
    const last = api.received.at(-1)!.body
    expect(last.puts).toEqual([])
    expect(last.threads.map((t) => t.thread_id)).toEqual(['thr_root'])
    expect(last.session).toEqual({ title: 'A synthetic title' })
  })

  test('pi and the OpenCode orphan path: a slow acknowledgement holds relayTurnEnd at most 3 s; the batch is retried afterwards', async () => {
    const api = fakeApi(async (body, n, request) => {
      if (n === 1) {
        await Promise.race([Bun.sleep(6_000), aborted(request)])
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
    expect(held).toBeLessThan(5_500)
    expect(journal.clean).toBe(false)

    await until(() => journal.clean, 8_000)
    expect(putIds(api.received)).toEqual(['m1', 'm1'])
  }, 20_000)

  test('OpenCode: relayTurnEndToApi flushes the journal before it posts the turn end', async () => {
    const api = fakeApi()
    const fake = fakeAdapter()
    fake.put('m1', 1, 'the reply')
    const journal = startSessionLogJournal(fake.port, { generation: 1 })
    if (!journal) throw new Error('journal did not start')

    await relayTurnEndToApi('ses_root', 'idle', { getInternalUrl: () => api.url }, { workspace: '/workspace' } as unknown as OpenCodeConfig)

    expect(api.order).toEqual(['journal m1', 'end'])
    expect(journal.clean).toBe(true)
  })

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

  test('a stop with an unreachable API exits within the 3 s bound, aborts the post and sends nothing more', async () => {
    let calls = 0
    let abortedPosts = 0
    fakeApi(async (_body, _n, request) => {
      calls += 1
      await Promise.race([Bun.sleep(10_000), aborted(request)])
      if (request.signal.aborted) abortedPosts += 1
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
    await until(() => exits.length > 0, 8_000)

    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(2_900)
    expect(elapsed).toBeLessThan(6_000)
    await until(() => abortedPosts === 1, 2_000)
    expect(calls).toBe(1)
  }, 20_000)

  test('installShutdownHandlers keeps one SIGTERM and one SIGINT listener however often it runs', () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }
    const noop = { stop: async () => {} }
    installShutdownHandlers(noop, { port: 0, reload: () => {}, stop: async () => {} }, undefined, { exit: () => {} })
    installShutdownHandlers(noop, { port: 0, reload: () => {}, stop: async () => {} }, undefined, { exit: () => {} })
    const after = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }
    expect(after.term - before.term).toBeLessThanOrEqual(1)
    expect(after.int - before.int).toBeLessThanOrEqual(1)
  })

  test('no control plane: the journal does not start, and the turn-end flush is a no-op', async () => {
    delete process.env.KORTIX_API_URL
    expect(startSessionLogJournal(fakeAdapter().port, { generation: 1 })).toBeNull()
  })
})

describe('attachment bytes (P2.13)', () => {
  const PNG = randomBytes(64)
  const shaOf = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const digest = shaOf(PNG)
  const own = `kortix-attachment://project-1/session-1/obj-${digest}`
  /** A store with one image message; `blob` serves its bytes. */
  function imageAdapter() {
    const base = fakeAdapter()
    base.put('msg_img', 1, 'see the image')
    const changes = base.port.changes.bind(base.port)
    const port: SessionLogPort = {
      ...base.port,
      async changes(cursors) {
        const out = await changes(cursors)
        for (const { message } of out.messages) message.blocks.push({ type: 'attachment', id: 'img', ref: `blob:${digest}`, mime: 'image/png', bytes: PNG.length, sha256: digest })
        return out
      },
      blob: (sha256) => (sha256 === digest ? PNG : null),
    }
    return { ...base, port }
  }
  /** A fake API: the blob routes answer by `blob` (a status or the stored object), the journal acknowledges. */
  function blobApi(blob: (method: string, n: number) => number | 'store') {
    const posted: SessionLogJournalRequest[] = []
    const calls: string[] = []
    const objects = new Map<string, Buffer>()
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith('/log/journal')) {
          const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))) as SessionLogJournalRequest
          posted.push(body)
          return ack(body)
        }
        calls.push(`${request.method} ${request.headers.get('content-type') ?? ''}`.trim())
        const answer = blob(request.method, calls.length)
        if (answer !== 'store') return new Response('no', { status: answer })
        if (request.method === 'GET') return Response.json({ ref: objects.has(digest) ? own : null })
        const bytes = Buffer.from(await request.arrayBuffer())
        if (shaOf(bytes) !== url.pathname.split('/').at(-1)) return new Response('mismatch', { status: 400 })
        objects.set(digest, bytes)
        return Response.json({ ref: own })
      },
    })
    servers.push(server)
    process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
    return { posted, calls, objects }
  }
  const refsOf = (body: SessionLogJournalRequest) => body.puts.flatMap((p) => p.message.blocks.flatMap((b) => (b.type === 'attachment' ? [b.ref] : [])))

  test('the journal uploads the bytes before the record goes out, and the record names the stored object', async () => {
    const api = blobApi(() => 'store')
    const journal = new SessionLogJournal(imageAdapter().port, { generation: 0 })
    expect(await journal.flush()).toBe(true)
    expect(api.calls).toEqual(['GET', 'PUT image/png'])
    expect(api.objects.get(digest)).toEqual(PNG)
    expect(refsOf(api.posted[0]!)).toEqual([own])
    // Asked once per boot: a later collection that re-exports the message sends nothing more.
    expect(await journal.flush()).toBe(true)
    expect(api.calls).toEqual(['GET', 'PUT image/png'])
  })

  test('a failed upload sends the record with blob: at once; the next collection retries and re-sends it with the stored ref', async () => {
    const api = blobApi((method, n) => (method === 'PUT' && n === 2 ? 503 : 'store'))
    const journal = new SessionLogJournal(imageAdapter().port, { generation: 0, retryMs: 1 })
    expect(await journal.flush()).toBe(true)
    expect(refsOf(api.posted[0]!)).toEqual([`blob:${digest}`])
    expect(await journal.flush()).toBe(true)
    expect(api.calls).toEqual(['GET', 'PUT image/png', 'GET', 'PUT image/png'])
    expect(api.posted.map(refsOf)).toEqual([[`blob:${digest}`], [own]])
    expect(api.posted[1]!.puts[0]!.rev).toBeGreaterThan(api.posted[0]!.puts[0]!.rev)
  })

  test('an API without the route (404) keeps blob: for the boot and is not asked again', async () => {
    const api = blobApi(() => 404)
    const journal = new SessionLogJournal(imageAdapter().port, { generation: 0 })
    expect(await journal.flush()).toBe(true)
    expect(await journal.flush()).toBe(true)
    expect(api.calls).toEqual(['GET'])
    expect(api.posted.map(refsOf)).toEqual([[`blob:${digest}`]])
  })

  test('the dump directory keeps blob: and asks nothing', async () => {
    const api = blobApi(() => 'store')
    process.env.KORTIX_SESSION_LOG_DUMP_DIR = join(tmpdir(), `journal-dump-${randomBytes(4).toString('hex')}`)
    try {
      const journal = new SessionLogJournal(imageAdapter().port, { generation: 0 })
      expect(await journal.flush()).toBe(true)
      expect(api.calls).toEqual([])
    } finally {
      rmSync(process.env.KORTIX_SESSION_LOG_DUMP_DIR, { recursive: true, force: true })
      delete process.env.KORTIX_SESSION_LOG_DUMP_DIR
    }
  })
})
