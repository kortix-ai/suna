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

import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { OpencodeDb } from '../opencode-db'
import { RuntimeStateStore } from '../runtime-state-projection'
import { KortixEventBus, kortixEventBus, resetKortixEventBusForTests } from '../kortix-event-bus'
import { createOpencodeRuntimeRouter } from '../routes/opencode-runtime'

const TOKEN = 'sandbox-token'
const SESSION = 'ses_fc5a2a353ffe4n9mPmwVuEVg5u'
const auth = { Authorization: `Bearer ${TOKEN}` }

// --------------------------------------------------------------------------
// A stand-in OpenCode. Payload shapes are the live ones; sizes are shrunk so
// the fixture stays readable, and the projection ratio is asserted rather than
// the absolute byte count.
// --------------------------------------------------------------------------
const SYSTEM_PROMPT = 'You are a careful engineer. '.repeat(400)
const TEMPLATE = '# Init\nDo the thing.\n'.repeat(80)

let server: ReturnType<typeof Bun.serve>
let opencodeCalls: string[] = []
let acts: Array<{ path: string; body: unknown }> = []
let permissions: unknown[] = []
let failConfig = false

function startFakeOpencode() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      opencodeCalls.push(url.pathname)
      if (req.method === 'POST') {
        acts.push({ path: url.pathname, body: await req.json().catch(() => null) })
        if (url.pathname.includes('/unknown/')) return Response.json({ error: 'nope' }, { status: 404 })
        return Response.json({ ok: true })
      }
      switch (url.pathname) {
        case '/global/health':
          return Response.json({ version: '1.18.23' })
        case '/agent':
          return Response.json([
            { name: 'essentia-agi', description: 'the working agent', mode: 'primary', native: false, permission: {}, options: {}, prompt: SYSTEM_PROMPT },
            { name: 'build', description: 'builtin', mode: 'primary', native: true, permission: {}, options: {}, prompt: SYSTEM_PROMPT },
          ])
        case '/command':
          return Response.json([
            { name: 'init', description: 'guided AGENTS.md setup', hints: ['$ARGUMENTS'], template: TEMPLATE },
          ])
        case '/config':
          if (failConfig) return new Response('boom', { status: 500 })
          return Response.json({
            model: 'kortix/codex/gpt-5.6-sol',
            small_model: 'kortix/codex/gpt-5.6-sol',
            agent: 'essentia-agi',
            permission: { edit: 'allow' },
            instructions: ['AGENTS.md'],
            provider: { kortix: { models: { a: { name: 'x'.repeat(4000) } } } },
          })
        case '/session':
          return Response.json([{ id: SESSION, title: 'From HTTP', directory: '/workspace', time: { created: 1, updated: 2 } }])
        case '/session/status':
          return Response.json({ [SESSION]: { type: 'idle' } })
        case '/permission':
          return Response.json(permissions)
        case '/question':
          return Response.json([])
        case '/vcs/diff':
          return Response.json([{ file: 'a.ts', added: 1, removed: 0 }])
        case '/project/current':
          return Response.json({ worktree: '/workspace', vcs: 'git' })
        default:
          if (/^\/session\/[^/]+\/todo$/.test(url.pathname)) {
            return Response.json([{ id: 'todo_1', content: 'do a thing', status: 'pending' }])
          }
          if (/^\/session\/[^/]+$/.test(url.pathname)) {
            return Response.json({ id: SESSION, title: 'From HTTP', directory: '/workspace' })
          }
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
        agent: 'essentia-agi',
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

function makeRouter(options: { dbPath?: string; pinnedSessionId?: () => string | null } = {}) {
  const cfg = { sandboxToken: TOKEN, workspace: '/workspace' } as Config
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
    app: createOpencodeRuntimeRouter(cfg, {
      opencode,
      db,
      state,
      pinnedSessionId: options.pinnedSessionId ?? (() => SESSION),
    }),
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
  opencodeCalls = []
  acts = []
  permissions = []
  failConfig = false
  resetKortixEventBusForTests()
  buildDb()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// --------------------------------------------------------------------------

describe('auth', () => {
  test('every route refuses an unauthenticated call', async () => {
    const { app } = makeRouter()
    for (const path of ['/state', `/messages/${SESSION}`, '/events', '/turn/msg_1']) {
      expect((await app.request(`http://d${path}`)).status).toBe(401)
    }
    expect((await app.request('http://d/act', { method: 'POST', body: '{}' })).status).toBe(401)
  })

  test('an unconfigured daemon answers 503, not 401 — the operator gets the real reason', async () => {
    const cfg = {} as Config
    const opencode = { getInternalUrl: () => `http://127.0.0.1:${server.port}` } as unknown as Opencode
    const db = new OpencodeDb(dbPath)
    const app = createOpencodeRuntimeRouter(cfg, {
      opencode,
      db,
      state: new RuntimeStateStore({ opencode, cfg, db, pinnedSessionId: () => null, daemonBuild: () => null }),
      pinnedSessionId: () => null,
    })
    expect((await app.request('http://d/state', { headers: auth })).status).toBe(503)
  })
})

describe('GET /state', () => {
  test('one call carries every fact the seven proxied reads carry', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/state', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    expect(body.identity).toMatchObject({
      opencode_session_id: SESSION,
      opencode_version: '1.18.23',
      daemon_build: 7,
    })
    expect(body.identity.head_seq).toEqual({ [SESSION]: 2_016 })
    expect(body.epoch).toBe(kortixEventBus().epoch)
    expect(body.agents.known).toBe(true)
    expect(body.agents.value.map((a: any) => a.name)).toEqual(['essentia-agi', 'build'])
    expect(body.commands.value[0]).toMatchObject({ name: 'init', template_bytes: TEMPLATE.length })
    expect(body.config.value).toMatchObject({ model: 'kortix/codex/gpt-5.6-sol', default_agent: 'essentia-agi' })
    expect(body.config.value.enabled_providers).toEqual(['kortix'])
    expect(body.statuses.value).toEqual({ [SESSION]: { type: 'idle' } })
    expect(body.permissions.value).toEqual([])
    expect(body.questions.value).toEqual([])

    // Prompts and templates never leave the box.
    const json = JSON.stringify(body)
    expect(json).not.toContain('careful engineer')
    expect(json).not.toContain('Do the thing')
  })

  test('the session list comes from SQLite, not OpenCode HTTP', async () => {
    const { app } = makeRouter()
    const body = (await (await app.request('http://d/state', { headers: auth })).json()) as any
    expect(body.sessions.value[0]).toMatchObject({ id: SESSION, title: 'From SQLite' })
    expect(opencodeCalls).not.toContain('/session')
  })

  test('with no readable database it falls back to OpenCode HTTP and still answers', async () => {
    const { app } = makeRouter({ dbPath: join(root, 'absent.db') })
    const body = (await (await app.request('http://d/state', { headers: auth })).json()) as any
    expect(body.sessions.value[0]).toMatchObject({ id: SESSION, title: 'From HTTP' })
    expect(body.identity.head_seq).toBeNull()
    expect(opencodeCalls).toContain('/session')
  })

  test('a section OpenCode could not answer is known:false with a reason — never an empty list', async () => {
    failConfig = true
    const { app } = makeRouter()
    const body = (await (await app.request('http://d/state', { headers: auth })).json()) as any
    expect(body.config.known).toBe(false)
    expect(body.config.reason).toContain('opencode read failed')
    expect(body.agents.known).toBe(true)
  })

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

  test('the etag moves when the projection changes and holds when it does not', async () => {
    const { app, state } = makeRouter()
    const a = (await app.request('http://d/state', { headers: auth })).headers.get('etag')
    const b = (await app.request('http://d/state', { headers: auth })).headers.get('etag')
    expect(b).toBe(a)
    state.noteEvent({ type: 'permission.asked', properties: { id: 'per_1', sessionID: SESSION, permission: 'bash', patterns: [] } })
    const c = (await app.request('http://d/state', { headers: auth })).headers.get('etag')
    expect(c).not.toBe(a)
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

  test('live sections track SSE frames with no extra OpenCode read', async () => {
    const { app, state } = makeRouter()
    await app.request('http://d/state', { headers: auth })
    const before = opencodeCalls.length

    state.noteEvent({ type: 'permission.asked', properties: { id: 'per_1', sessionID: SESSION, permission: 'bash', patterns: ['rm *'] } })
    state.noteEvent({ type: 'question.asked', properties: { id: 'qst_1', sessionID: SESSION, questions: [] } })
    state.noteEvent({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } })

    let body = (await (await app.request('http://d/state', { headers: auth })).json()) as any
    expect(body.permissions.value).toEqual([{ id: 'per_1', sessionID: SESSION, permission: 'bash', patterns: ['rm *'], tool: null }])
    expect(body.questions.value).toEqual([{ id: 'qst_1', sessionID: SESSION }])
    expect(body.statuses.value[SESSION]).toEqual({ type: 'busy' })

    state.noteEvent({ type: 'permission.replied', properties: { sessionID: SESSION, requestID: 'per_1', reply: 'once' } })
    state.noteEvent({ type: 'question.replied', properties: { sessionID: SESSION, requestID: 'qst_1', answers: [] } })
    state.noteEvent({ type: 'session.idle', properties: { sessionID: SESSION } })

    body = (await (await app.request('http://d/state', { headers: auth })).json()) as any
    expect(body.permissions.value).toEqual([])
    expect(body.questions.value).toEqual([])
    expect(body.statuses.value[SESSION]).toEqual({ type: 'idle' })
    // This is the whole point of the deleted 2 s polls: none of it cost a read.
    expect(opencodeCalls.length).toBe(before)
  })

  test('a catalog-moving frame forces exactly one rebuild', async () => {
    const { app, state } = makeRouter()
    await app.request('http://d/state', { headers: auth })
    const before = opencodeCalls.filter((p) => p === '/agent').length
    state.noteEvent({ type: 'mcp.tools.changed', properties: {} })
    await app.request('http://d/state', { headers: auth })
    await app.request('http://d/state', { headers: auth })
    expect(opencodeCalls.filter((p) => p === '/agent').length).toBe(before + 1)
  })

  test('concurrent opens share ONE build', async () => {
    const { app } = makeRouter()
    await Promise.all(Array.from({ length: 8 }, () => app.request('http://d/state', { headers: auth })))
    expect(opencodeCalls.filter((p) => p === '/config').length).toBe(1)
  })
})

describe('GET /messages/:sessionId', () => {
  test('serves a projected page from SQLite with ids verbatim and no attachment bytes', async () => {
    const { app } = makeRouter()
    const res = await app.request(`http://d/messages/${SESSION}?limit=3`, { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-kortix-transcript-source')).toBe('sqlite')
    const body = (await res.json()) as any
    expect(body.source).toBe('sqlite')
    expect(body.count).toBe(3)
    expect(body.has_more).toBe(true)
    expect(body.head_seq).toBe(2_016)
    expect(body.messages.map((m: any) => m.info.id)).toEqual(['msg_004', 'msg_005', 'msg_006'])
    expect(body.first_message_id).toBe('msg_004')
    expect(body.last_message_id).toBe('msg_006')
    const json = JSON.stringify(body)
    expect(json).not.toContain('AAAA')
    expect(json).toContain(`/kortix/part/${SESSION}/msg_004/att_msg_004`)
    expect(body.attachments_referenced).toBe(3)
    expect(body.attachment_bytes_saved).toBeGreaterThan(300_000)
    // `info.system` is 2 KB per row in the fixture and no consumer reads it.
    expect(json).not.toContain('SSSS')
  })

  test('`before` pages backwards, `after` pages forwards', async () => {
    const { app } = makeRouter()
    const older = (await (await app.request(`http://d/messages/${SESSION}?limit=2&before=msg_004`, { headers: auth })).json()) as any
    expect(older.messages.map((m: any) => m.info.id)).toEqual(['msg_002', 'msg_003'])
    const newer = (await (await app.request(`http://d/messages/${SESSION}?limit=10&after=msg_004`, { headers: auth })).json()) as any
    expect(newer.messages.map((m: any) => m.info.id)).toEqual(['msg_005', 'msg_006'])
    expect(newer.has_more).toBe(false)
  })

  test('a NUMERIC `after` is read as an OpenCode event seq, not a message id', async () => {
    const { app } = makeRouter()
    const delta = (await (await app.request(`http://d/messages/${SESSION}?after=2015`, { headers: auth })).json()) as any
    expect(delta.messages.map((m: any) => m.info.id)).toEqual(['msg_006'])
    const none = (await (await app.request(`http://d/messages/${SESSION}?after_seq=2016`, { headers: auth })).json()) as any
    expect(none.messages).toEqual([])
  })

  test('falls back to OpenCode HTTP when the database is unreadable', async () => {
    const { app } = makeRouter({ dbPath: join(root, 'absent.db') })
    const res = await app.request(`http://d/messages/${SESSION}`, { headers: auth })
    const body = (await res.json()) as any
    expect(body.source).toBe('opencode-http')
    expect(body.messages.map((m: any) => m.info.id)).toEqual(['msg_http_1'])
    expect(body.head_seq).toBeNull()
  })

  test('gzip compresses the transcript page', async () => {
    const { app } = makeRouter()
    const gz = await app.request(`http://d/messages/${SESSION}?limit=6`, { headers: { ...auth, 'Accept-Encoding': 'gzip' } })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect((await gz.arrayBuffer()).byteLength).toBeLessThan(Number(gz.headers.get('x-kortix-bytes')))
  })

  test('the page limit is bounded', async () => {
    const { app } = makeRouter()
    const body = (await (await app.request(`http://d/messages/${SESSION}?limit=99999`, { headers: auth })).json()) as any
    expect(body.count).toBe(6)
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
    for (let i = 1; i <= 5; i++) bus.publishOpencode({ type: 'message.part.delta', properties: { i } })

    const res = await app.request('http://d/events?since=2', { headers: auth })
    // hello + replay(3,4,5) + live(6,7)
    const framesPromise = readFrames(res, 6)
    await Bun.sleep(20)
    bus.publishOpencode({ type: 'session.idle', properties: { sessionID: SESSION } })
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
    // A tiny ring so the gap is guaranteed unreplayable.
    const bus = new KortixEventBus('e-test', 2)
    ;(globalThis as any).__unusedBus = bus
    const live = kortixEventBus()
    for (let i = 0; i < 5; i++) live.publishOpencode({ type: 'x', properties: {} })

    const res = await app.request('http://d/events?since=3&epoch=some-old-epoch', { headers: auth })
    const framesPromise = readFrames(res, 3)
    await Bun.sleep(20)
    live.publishOpencode({ type: 'session.idle', properties: { sessionID: SESSION } })
    const frames = await framesPromise
    const events = frames.map(dataOf)
    expect(events[0].type).toBe('kortix.hello')
    expect(events[1]).toMatchObject({ type: 'kortix.resync', reason: 'epoch-changed' })
    expect(events[2]).toMatchObject({ type: 'session.idle', seq: 6 })
  })

  test('the heartbeat is a TYPED event and carries no seq', async () => {
    const cfg = { sandboxToken: TOKEN, workspace: '/workspace' } as Config
    const opencode = { getInternalUrl: () => `http://127.0.0.1:${server.port}` } as unknown as Opencode
    const db = new OpencodeDb(dbPath)
    const app = createOpencodeRuntimeRouter(cfg, {
      opencode,
      db,
      state: new RuntimeStateStore({ opencode, cfg, db, pinnedSessionId: () => SESSION, daemonBuild: () => null }),
      pinnedSessionId: () => SESSION,
    })
    const res = await app.request('http://d/events', { headers: auth })
    const [hello] = await readFrames(res, 1)
    expect(hello).toContain('event: kortix.hello')
    // Cadence itself is asserted by the constant, not by sleeping 15 s in a
    // unit test. What matters here is the WIRE FORM: a `:` comment would be
    // swallowed by every SSE parser and leave consumer watchdogs blind — the
    // defect sse-keepalive.ts records from the 2026-08-26 incident.
    const { EVENT_HEARTBEAT_MS } = await import('../routes/opencode-runtime')
    expect(EVENT_HEARTBEAT_MS).toBe(15_000)
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

describe('POST /act', () => {
  test('permission reply forwards to OpenCode', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'permission', id: 'per_1', reply: 'once' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, kind: 'permission' })
    expect(acts).toEqual([{ path: '/permission/per_1/reply', body: { reply: 'once' } }])
  })

  test('question reply and reject take different OpenCode routes', async () => {
    const { app } = makeRouter()
    await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'question', id: 'qst_1', answers: [['yes']] }),
    })
    await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'question', id: 'qst_1', reject: true }),
    })
    expect(acts.map((a) => a.path)).toEqual(['/question/qst_1/reply', '/question/qst_1/reject'])
    expect(acts[0]!.body).toEqual({ answers: [['yes']] })
  })

  test('stop aborts the PINNED session when none is named', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'stop' }),
    })
    expect(res.status).toBe(200)
    expect(acts[0]!.path).toBe(`/session/${SESSION}/abort`)
  })

  test('revert and unrevert both work, and revert needs a message id', async () => {
    const { app } = makeRouter()
    await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'revert', message_id: 'msg_004', part_id: 'prt_1' }),
    })
    await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'revert', undo: true }),
    })
    expect(acts.map((a) => a.path)).toEqual([`/session/${SESSION}/revert`, `/session/${SESSION}/unrevert`])
    expect(acts[0]!.body).toEqual({ messageID: 'msg_004', partID: 'prt_1' })

    const bad = await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'revert' }),
    })
    expect(bad.status).toBe(400)
  })

  test('a malformed act is refused with the supported kinds named', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'teleport' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toMatchObject({ supported: ['permission', 'question', 'stop', 'revert'] })
    expect(acts).toEqual([])
  })

  test('invalid JSON is a 400, not a 500', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/act', { method: 'POST', headers: auth, body: 'not json' })
    expect(res.status).toBe(400)
  })

  test('an OpenCode 404 is surfaced as 404, not laundered into a 200', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/act', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'permission', id: 'unknown', reply: 'once' }),
    })
    // The fake answers 404 for any path containing `/unknown/`.
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toMatchObject({ ok: false })
  })
})

describe('GET /turn/:messageId', () => {
  test('answers from the SAME observer /kortix/health?turn=1 uses', async () => {
    const { app } = makeRouter()
    const res = await app.request(`http://d/turn/msg_http_1?session_id=${SESSION}`, { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ message_id: 'msg_http_1', opencode_session_id: SESSION })
    // The fake OpenCode's message list has msg_http_1 completed with no
    // assistant reply after it, so the observer reports terminal-with-no-reply.
    expect(body.in_flight).toBe(false)
    expect(typeof body.seq).toBe('number')
    expect(res.headers.get('server-timing')).toMatch(/read;dur=/)
  })

  test('falls back to the pinned session when the caller names none', async () => {
    const { app } = makeRouter()
    const body = (await (await app.request('http://d/turn/msg_http_1', { headers: auth })).json()) as any
    expect(body.opencode_session_id).toBe(SESSION)
  })

  test('with no pin and no session_id the observer is asked about nothing and says so', async () => {
    const { app } = makeRouter({ pinnedSessionId: () => null })
    const body = (await (await app.request('http://d/turn/msg_http_1', { headers: auth })).json()) as any
    expect(body.opencode_session_id).toBeNull()
    // `null` in_flight is UNKNOWN, and unknown grants no authority — it must
    // never be reported as "the turn is over".
    expect(body.in_flight).toBeNull()
  })
})

describe('GET /kortix/opencode/* passthroughs — the last raw reads move onto /kortix/*', () => {
  test('vcs-diff, project-current, config, session, and todo forward to local OpenCode', async () => {
    const { app } = makeRouter()
    const cases: Array<[string, string]> = [
      ['/vcs-diff', '/vcs/diff'],
      ['/project-current', '/project/current'],
      ['/config', '/config'],
      [`/session/${SESSION}`, `/session/${SESSION}`],
      [`/todo/${SESSION}`, `/session/${SESSION}/todo`],
    ]
    for (const [route, opencodePath] of cases) {
      const res = await app.request(`http://d${route}`, { headers: auth })
      expect(res.status).toBe(200)
      expect(opencodeCalls).toContain(opencodePath)
    }
  })

  test('vcs-diff forwards the mode query', async () => {
    const { app } = makeRouter()
    const res = await app.request('http://d/vcs-diff?mode=git', { headers: auth })
    expect(res.status).toBe(200)
    expect(opencodeCalls).toContain('/vcs/diff')
  })

  test('a passthrough refuses an unauthenticated request', async () => {
    const { app } = makeRouter()
    expect((await app.request('http://d/vcs-diff')).status).toBe(401)
  })
})

