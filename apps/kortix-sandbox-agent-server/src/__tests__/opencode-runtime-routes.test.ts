import { publishOpenCodeEvent } from '@/harness/open-code/event-bus'
/**
 * `/kortix/opencode/*` end to end, against a REAL local OpenCode stand-in and a
 * REAL fixture `opencode.db`.
 *
 * Nothing here is mocked at the module boundary: the router talks HTTP to a
 * `Bun.serve` that answers OpenCode's payload shapes, and SQLite to a database
 * built with the live 1.18.23 schema. The point is to assert the wire — status,
 * headers, bytes, and the exact fields a client reads — not the internals.
 */
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '@/harness/open-code/config'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { RuntimeStateStore } from '@/harness/open-code/runtime-state-projection'
import { kortixEventBus, resetKortixEventBusForTests, sessionLogEventBus } from '@/services/event-bus/kortix-event-bus'
import { createRuntimeRouter } from '@/routes/kortix/runtime'
import { createOpenCodeQueryService } from '@/harness/open-code/queries'

const TOKEN = 'sandbox-token'
const SESSION = 'ses_test00000000000000routes'
const auth = { Authorization: `Bearer ${TOKEN}` }

// --------------------------------------------------------------------------
// A stand-in OpenCode. Payload shapes are the live ones; sizes are shrunk so
// the fixture stays readable, and the projection ratio is asserted rather than
// the absolute byte count.
// --------------------------------------------------------------------------
const SYSTEM_PROMPT = 'You are a careful engineer. '.repeat(400)
const TEMPLATE = '# Init\nDo the thing.\n'.repeat(80)

let server: ReturnType<typeof Bun.serve>

function startFakeOpencode() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      switch (url.pathname) {
        case '/global/health':
          return Response.json({ version: '1.18.23' })
        case '/agent':
          return Response.json([
            { name: 'sampleco-agi', description: 'the working agent', mode: 'primary', native: false, permission: {}, options: {}, prompt: SYSTEM_PROMPT },
            { name: 'build', description: 'builtin', mode: 'primary', native: true, permission: {}, options: {}, prompt: SYSTEM_PROMPT },
          ])
        case '/command':
          return Response.json([
            { name: 'init', description: 'guided AGENTS.md setup', hints: ['$ARGUMENTS'], template: TEMPLATE },
          ])
        case '/config':
          return Response.json({
            model: 'kortix/codex/gpt-5.6-sol',
            small_model: 'kortix/codex/gpt-5.6-sol',
            agent: 'sampleco-agi',
            permission: { edit: 'allow' },
            instructions: ['AGENTS.md'],
            provider: { kortix: { models: { a: { name: 'x'.repeat(4000) } } } },
          })
        case '/session':
          return Response.json([{ id: SESSION, title: 'From HTTP', directory: '/workspace', time: { created: 1, updated: 2 } }])
        case '/session/status':
          return Response.json({ [SESSION]: { type: 'idle' } })
        case '/permission':
          return Response.json([])
        case '/question':
          return Response.json([])
        default:
          if (/^\/session\/[^/]+\/message$/.test(url.pathname)) {
            return Response.json([
              {
                info: { id: 'msg_http_1', sessionID: SESSION, role: 'assistant', time: { created: 1, completed: 2 } },
                parts: [{ id: 'prt_http_1', messageID: 'msg_http_1', sessionID: SESSION, type: 'text', text: 'from http' }],
              },
            ])
          }
          return new Response('not found', { status: 404 })
      }
    },
  })
}

// --------------------------------------------------------------------------
// Fixture opencode.db
// --------------------------------------------------------------------------
let root: string
let dbPath: string

function buildDb(messages = 6, attachmentBytes = 120_000): void {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  // A throwaway temp database: durability costs real fsyncs, and on a loaded
  // worker sandbox that pushed the beforeEach past bun's 5 s default.
  db.exec('PRAGMA synchronous = OFF')
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
      directory text NOT NULL, title text NOT NULL, version text NOT NULL, revert text, agent text, model text,
      time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL);
    CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
  `)
  db.query(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'prj_1', 'slug', '/workspace', 'From SQLite', '1.18.23', 1, 99)`,
  ).run(SESSION)
  for (let i = 1; i <= messages; i++) {
    const id = `msg_${String(i).padStart(3, '0')}`
    db.query('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
      id,
      SESSION,
      i * 10,
      i * 10,
      JSON.stringify({
        id,
        sessionID: SESSION,
        role: i % 2 === 0 ? 'assistant' : 'user',
        time: { created: i * 10, completed: i * 10 + 1 },
        agent: 'sampleco-agi',
        // Weight the raw row the way a live message is weighted.
        system: 'S'.repeat(2_000),
      }),
    )
    db.query('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(
      `prt_${id}_text`,
      id,
      SESSION,
      i * 10,
      i * 10,
      JSON.stringify({ id: `prt_${id}_text`, messageID: id, sessionID: SESSION, type: 'text', text: `body ${i}` }),
    )
    db.query('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(
      `prt_${id}_shot`,
      id,
      SESSION,
      i * 10,
      i * 10,
      JSON.stringify({
        id: `prt_${id}_shot`,
        messageID: id,
        sessionID: SESSION,
        type: 'tool',
        tool: 'browser',
        callID: `call_${i}`,
        state: {
          status: 'completed',
          title: 'screenshot',
          input: {},
          output: 'ok',
          time: { start: 1, end: 2 },
          attachments: [
            { id: `att_${id}`, type: 'file', mime: 'image/png', url: `data:image/png;base64,${'A'.repeat(attachmentBytes)}` },
          ],
        },
      }),
    )
  }
  db.query('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)').run(
    'evt_1',
    SESSION,
    2_016,
    'message.updated.1',
    JSON.stringify({ info: { id: `msg_${String(messages).padStart(3, '0')}` } }),
  )
  db.query('INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)').run(SESSION, 2_016)
  db.close()
}

function makeRouter(options: { dbPath?: string } = {}) {
  const cfg = { sandboxToken: TOKEN, workspace: '/workspace', opencodeInternalPort: 4096, opencodeStandbyPort: 4097, defaultOpencodeConfigDir: '/workspace/.kortix/opencode' } as Config
  const opencode = {
    getInternalUrl: () => `http://127.0.0.1:${server.port}`,
    getState: () => 'ok',
    getPid: () => 1,
    getActivePort: () => server.port,
  } as unknown as Opencode
  const db = new OpencodeDb(options.dbPath ?? dbPath)
  const state = new RuntimeStateStore({
    opencode,
    cfg,
    db,
    pinnedSessionId: () => SESSION,
    daemonBuild: () => 7,
  })
  return {
    app: createRuntimeRouter(cfg, createOpenCodeQueryService(opencode, { db, state }).bind({ cfg })),
    state,
    db,
    cfg,
    opencode,
  }
}

beforeAll(() => {
  server = startFakeOpencode()
})
afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-runtime-'))
  dbPath = join(root, 'opencode.db')
  resetKortixEventBusForTests()
  buildDb()
})

afterEach(() => {
  // Module-level state: clear it on the way OUT too, or the next file in this
  // bun process inherits it (see test-state-reset-tripwire.test.ts).
  resetKortixEventBusForTests()
  rmSync(root, { recursive: true, force: true })
})

// --------------------------------------------------------------------------

describe('auth', () => {
  test('every route refuses an unauthenticated call', async () => {
    const { app } = makeRouter()
    for (const path of ['/state', `/messages/${SESSION}`, '/events']) {
      expect((await app.request(`http://d${path}`)).status).toBe(401)
    }
  })

  test('an unconfigured daemon answers 503, not 401 — the operator gets the real reason', async () => {
    const cfg = { opencodeInternalPort: 4096, opencodeStandbyPort: 4097, defaultOpencodeConfigDir: '/workspace/.kortix/opencode' } as Config
    const opencode = { getInternalUrl: () => `http://127.0.0.1:${server.port}` } as unknown as Opencode
    const db = new OpencodeDb(dbPath)
    const app = createRuntimeRouter(cfg, createOpenCodeQueryService(opencode, {
      db,
      state: new RuntimeStateStore({ opencode, cfg, db, pinnedSessionId: () => null, daemonBuild: () => null }),
    }).bind({ cfg }))
    expect((await app.request('http://d/state', { headers: auth })).status).toBe(503)
  })
})

describe('GET /state', () => {
  test('If-None-Match answers 304 with no body', async () => {
    const { app } = makeRouter()
    const first = await app.request('http://d/state', { headers: auth })
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"sha256-[0-9a-f]{32}"$/)
    const second = await app.request('http://d/state', { headers: { ...auth, 'If-None-Match': etag } })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    expect(second.headers.get('etag')).toBe(etag)
  })

  test('a weak or listed If-None-Match still matches', async () => {
    const { app } = makeRouter()
    const etag = (await app.request('http://d/state', { headers: auth })).headers.get('etag')!
    expect((await app.request('http://d/state', { headers: { ...auth, 'If-None-Match': `W/${etag}` } })).status).toBe(304)
    expect((await app.request('http://d/state', { headers: { ...auth, 'If-None-Match': `"other", ${etag}` } })).status).toBe(304)
    expect((await app.request('http://d/state', { headers: { ...auth, 'If-None-Match': '"stale"' } })).status).toBe(200)
  })

  test('gzip on when asked and the body earns it; plain when not asked', async () => {
    const { app } = makeRouter()
    const gz = await app.request('http://d/state', { headers: { ...auth, 'Accept-Encoding': 'gzip' } })
    const plain = await app.request('http://d/state', { headers: auth })
    const rawBytes = Number(plain.headers.get('x-kortix-bytes'))
    expect(rawBytes).toBeGreaterThan(1024)
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(plain.headers.get('content-encoding')).toBeNull()
    const gzBytes = (await gz.arrayBuffer()).byteLength
    expect(gzBytes).toBeLessThan(rawBytes)
  })

  test('Server-Timing names the read and the total', async () => {
    const { app } = makeRouter()
    const timing = (await app.request('http://d/state', { headers: auth })).headers.get('server-timing')!
    expect(timing).toMatch(/read;dur=[\d.]+/)
    expect(timing).toMatch(/total;dur=[\d.]+/)
  })
})

describe('GET /messages/:sessionId', () => {
  test('gzip compresses the transcript page', async () => {
    const { app } = makeRouter()
    const gz = await app.request(`http://d/messages/${SESSION}?limit=6`, { headers: { ...auth, 'Accept-Encoding': 'gzip' } })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect((await gz.arrayBuffer()).byteLength).toBeLessThan(Number(gz.headers.get('x-kortix-bytes')))
  })
})

describe('GET /events (SSE)', () => {
  async function readFrames(res: Response, want: number, budgetMs = 2_000): Promise<string[]> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const frames: string[] = []
    let buf = ''
    const deadline = Date.now() + budgetMs
    while (frames.length < want && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let index = buf.indexOf('\n\n')
      while (index !== -1) {
        frames.push(buf.slice(0, index))
        buf = buf.slice(index + 2)
        index = buf.indexOf('\n\n')
      }
    }
    await reader.cancel()
    return frames
  }

  function dataOf(frame: string): any {
    const line = frame.split('\n').find((l) => l.startsWith('data:'))!
    return JSON.parse(line.slice(5).trim())
  }

  test('opens with kortix.hello naming the epoch and the cursor', async () => {
    const { app } = makeRouter()
    const bus = kortixEventBus()
    const res = await app.request('http://d/events', { headers: auth })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('x-kortix-epoch')).toBe(bus.epoch)
    const [hello] = await readFrames(res, 1)
    expect(dataOf(hello!)).toMatchObject({ type: 'kortix.hello', epoch: bus.epoch, head_seq: 0 })
  })

  test('replays the gap then hands off to live with no loss and no duplication', async () => {
    const { app } = makeRouter()
    const bus = kortixEventBus()
    for (let i = 1; i <= 5; i++) publishOpenCodeEvent(bus, { type: 'message.part.delta', properties: { i } })

    const res = await app.request(`http://d/events?since=2&epoch=${bus.epoch}`, { headers: auth })
    // hello + replay(3,4,5) + live(6,7)
    const framesPromise = readFrames(res, 6)
    await Bun.sleep(20)
    publishOpenCodeEvent(bus, { type: 'session.idle', properties: { sessionID: SESSION } })
    bus.publishDaemon('kortix.turn', { verdict: 'idle' }, SESSION)
    const frames = await framesPromise

    const events = frames.map(dataOf)
    expect(events[0].type).toBe('kortix.hello')
    const sequenced = events.slice(1)
    expect(sequenced.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7])
    expect(sequenced.map((e) => e.type)).toEqual([
      'message.part.delta',
      'message.part.delta',
      'message.part.delta',
      'session.idle',
      'kortix.turn',
    ])
    // The SSE `id:` field carries the same cursor, so a client that resumes
    // with `Last-Event-ID` and one that tracks `seq` agree.
    const ids = frames.slice(1).map((f) => f.split('\n').find((l) => l.startsWith('id:'))!.slice(3).trim())
    expect(ids).toEqual(['3', '4', '5', '6', '7'])
  })

  test('an unreplayable cursor gets kortix.resync and then live events, never a silent hole', async () => {
    const { app } = makeRouter()
    // A cursor from another daemon boot cannot be replayed onto this one.
    const live = kortixEventBus()
    for (let i = 0; i < 5; i++) publishOpenCodeEvent(live, { type: 'x', properties: {} })

    const res = await app.request('http://d/events?since=3&epoch=some-old-epoch', { headers: auth })
    const framesPromise = readFrames(res, 3)
    await Bun.sleep(20)
    publishOpenCodeEvent(live, { type: 'session.idle', properties: { sessionID: SESSION } })
    const frames = await framesPromise
    const events = frames.map(dataOf)
    expect(events[0].type).toBe('kortix.hello')
    expect(events[1]).toMatchObject({ type: 'kortix.resync', reason: 'epoch-changed' })
    expect(events[2]).toMatchObject({ type: 'session.idle', seq: 6 })
  })

  test('a consumer that never reads is dropped once its queue passes the cap, never buffered forever', async () => {
    const { app } = makeRouter()
    const bus = kortixEventBus()
    const res = await app.request('http://d/events', { headers: auth })
    // Nothing reads the body: every frame queues in the stream.
    for (let i = 0; i < 1_500; i++) publishOpenCodeEvent(bus, { type: 'message.part.delta', properties: { i } })
    const reader = res.body!.getReader()
    let frames = 0
    const deadline = Date.now() + 2_000
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))),
      ])
      if (chunk.done) break
      frames += 1
    }
    // The stream ENDED (client reconnects with its cursor) and queued at most the cap + hello.
    expect(Date.now()).toBeLessThan(deadline)
    expect(frames).toBeLessThan(1_100)
    // A later event reaches no listener of the dropped stream: publish must not grow its queue.
    publishOpenCodeEvent(bus, { type: 'x', properties: {} })
  })

  test('the heartbeat is a TYPED event every 15 s and carries no seq', async () => {
    // Capture the stream's interval instead of sleeping 15 s. What matters is
    // the WIRE FORM: a `:` comment would be swallowed by every SSE parser and
    // leave consumer watchdogs blind — the defect sse-keepalive.ts records.
    const { app } = makeRouter()
    const realSetInterval = globalThis.setInterval
    const intervals: Array<{ tick: () => void; ms: number | undefined }> = []
    globalThis.setInterval = ((tick: () => void, ms?: number) => {
      intervals.push({ tick, ms })
      return realSetInterval(() => {}, 1 << 30)
    }) as typeof setInterval
    let res: Response
    try {
      res = await app.request('http://d/events', { headers: auth })
    } finally {
      globalThis.setInterval = realSetInterval
    }
    const framesPromise = readFrames(res, 2)
    await Bun.sleep(10)
    expect(intervals.map((i) => i.ms)).toEqual([15_000])
    intervals[0]!.tick()
    const [hello, heartbeat] = await framesPromise
    expect(hello).toContain('event: kortix.hello')
    expect(heartbeat!.split('\n')[0]).toBe('event: kortix.heartbeat')
    expect(heartbeat).not.toMatch(/^id:/m)
    const data = dataOf(heartbeat!)
    expect(data.type).toBe('kortix.heartbeat')
    expect(data).not.toHaveProperty('seq')
  })

  test('a reader that falls too far behind is dropped, so its queue stays bounded', async () => {
    // The API stops reading while its own client is slow (R5.1 backpressure).
    // The daemon then ends this stream instead of queueing without limit; the
    // API reconnects with its cursor and the ring replays what it missed.
    const { app } = makeRouter()
    const bus = kortixEventBus()
    const res = await app.request('http://d/events', { headers: auth })
    for (let i = 0; i < 10_000; i++) {
      publishOpenCodeEvent(bus, { type: 'message.part.delta', properties: { i } })
    }
    expect(bus.subscriberCount).toBe(0)
    const frames = await readFrames(res, 20_000, 2_000)
    // hello + at most the bounded backlog, then the end of the stream.
    expect(frames.length).toBeLessThan(5_000)
    // The ring still holds everything the reader missed.
    expect(bus.subscribe(() => {}, { since: 0, epoch: bus.epoch }).replay).toHaveLength(10_000)
  })

  test('schema negotiation: the default, empty and schema=v1 streams are the v1 bus byte for byte; schema=v2 is the log bus plus every v1 frame but the transcript', async () => {
    const { app } = makeRouter()
    const bus = kortixEventBus()
    const logBus = sessionLogEventBus()
    publishOpenCodeEvent(bus, { type: 'message.part.delta', properties: { sessionID: SESSION, messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: 'Hel' } })
    logBus.publish('log.block.delta', { thread_id: SESSION, message_id: 'msg_a', block_id: 'prt_a', delta: 'Hel' }, SESSION)
    publishOpenCodeEvent(bus, { type: 'session.idle', properties: { sessionID: SESSION } })
    logBus.publish('log.thread', { thread_id: SESSION }, SESSION)
    bus.publishDaemon('kortix.turn', { verdict: 'idle' }, SESSION)
    publishOpenCodeEvent(bus, { type: 'message.updated', properties: { sessionID: SESSION, info: { id: 'msg_a', role: 'assistant' } } })
    publishOpenCodeEvent(bus, { type: 'permission.asked', properties: { id: 'per_a', sessionID: SESSION, permission: 'bash' } })
    // The frame format before schema negotiation existed: `event`, `id`, `data` of each v1 envelope.
    const v1Frames = bus.subscribe(() => {}, { since: 0, epoch: bus.epoch }).replay.map((e) => `event: ${e.type}\nid: ${e.seq}\ndata: ${JSON.stringify(e)}`)
    expect(v1Frames).toHaveLength(5)
    const read = async (query: string, want: number) => {
      const res = await app.request(`http://d/events?${query}since=0`, { headers: auth })
      expect(res.status).toBe(200)
      return { epoch: res.headers.get('x-kortix-epoch'), frames: await readFrames(res, want) }
    }
    for (const query of ['', 'schema=&', 'schema=v1&']) {
      const { epoch, frames } = await read(query, 6)
      expect(epoch).toBe(bus.epoch)
      expect(dataOf(frames[0]!)).toMatchObject({ type: 'kortix.hello', epoch: bus.epoch, head_seq: 5, first_seq: 1 })
      expect(frames.slice(1)).toEqual(v1Frames)
      expect(frames.join('\n')).not.toContain('log.')
    }
    const { epoch, frames } = await read('schema=v2&', 6)
    expect(epoch).toBe(logBus.epoch)
    expect(logBus.epoch).not.toBe(bus.epoch)
    expect(dataOf(frames[0]!)).toMatchObject({ type: 'kortix.hello', epoch: logBus.epoch, head_seq: 5 })
    // Its own dense seqs; the v1 frames that are not transcript content ride along unchanged (P4.3b); no message.* frame.
    const v2 = frames.slice(1).map(dataOf)
    expect(v2.map((e) => [e.seq, e.type])).toEqual([[1, 'log.block.delta'], [2, 'session.idle'], [3, 'log.thread'], [4, 'kortix.turn'], [5, 'permission.asked']])
    expect(v2[1]!.payload).toEqual({ sessionID: SESSION })
    expect(v2[4]!.payload).toEqual({ id: 'per_a', sessionID: SESSION, permission: 'bash' })
    expect(frames.join('\n')).not.toContain('message.')
  })

  test('an unknown schema is a 400 that names the supported ones', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/events?schema=v3', { headers: auth })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown schema', schema: 'v3', supported: ['v1', 'v2'] })
  })

  test('cancelling the stream unsubscribes', async () => {
    const { app } = makeRouter()
    const bus = kortixEventBus()
    const res = await app.request('http://d/events', { headers: auth })
    await readFrames(res, 1)
    await Bun.sleep(10)
    expect(bus.subscriberCount).toBe(0)
  })
})
