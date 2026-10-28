/**
 * When the boot restores a session log (P6.4, `harness/shared/session-log-boot.ts`), against a
 * fake native store and a fake API (`Bun.serve`: manifest, restore, attachments). The real
 * harnesses run the same reconcile in `pi-session-log-restore.test.ts` and
 * `opencode-session-log-restore-boot-reconcile.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AdapterCapabilities,
  ExportCursor,
  SessionLog,
  SessionLogJournalRequest,
  SessionLogManifest,
  SessionLogMessage,
  SessionLogRestore,
  SessionLogRestoreTooLarge,
} from '@kortix/api-contract/session-log'
import type { SessionLogPort } from '@/harness/contract/session-log'
import { WIRE_MESSAGE_ID } from '@kortix/sdk/wire-message-id'
import { reconcileSessionLog, sessionLogBootStatePath } from '@/harness/shared/session-log-boot'
import { resetSessionLogJournalForTests, SessionLogJournal } from '@/harness/shared/session-log-journal'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'

const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_RUNTIME_STATE_DIR', 'KORTIX_SESSION_LOG_RESTORE'] as const
let saved: Record<string, string | undefined> = {}
const servers: Array<{ stop(closeActive?: boolean): void }> = []
let stateDir: string

beforeEach(() => {
  resetKortixEventBusForTests()
  resetSessionLogJournalForTests()
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  stateDir = mkdtempSync(join(tmpdir(), 'session-log-boot-'))
  Object.assign(process.env, {
    KORTIX_PROJECT_ID: 'project-1',
    KORTIX_SESSION_ID: 'session-1',
    KORTIX_TOKEN: 'session-token',
    KORTIX_RUNTIME_STATE_DIR: stateDir,
    KORTIX_SESSION_LOG_RESTORE: '1',
  })
})

afterEach(() => {
  resetSessionLogJournalForTests()
  resetKortixEventBusForTests()
  for (const s of servers.splice(0)) s.stop(true)
  rmSync(stateDir, { recursive: true, force: true })
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const FEATURES = {
  tool_error_channel: true,
  attachments: { user: [], tool_result: false },
  compaction: [],
  subagents: 'none',
  todos: false,
  reasoning_replay: 'none',
  freeform_tool_input: false,
} satisfies AdapterCapabilities['native']
const CAPABILITIES: AdapterCapabilities = { harness: 'fake', harness_versions: '*', schema_minors: [1], dialects: [], native: FEATURES, rendered: FEATURES }
const AT = '2026-10-13T00:00:00.000Z'

function message(id: string, seq: number, text: string, extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
  return {
    schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'thr_root', seq, role: 'assistant', kind: 'turn', status: 'complete', in_context: true,
    model: null, usage: null, finish: 'stop', error: null, created_at: AT, completed_at: AT,
    producer: { harness: 'fake', harness_version: '0', adapter_version: '1' }, blocks: [{ type: 'text', id: `${id}-b1`, text }], ...extra,
  }
}

function log(messages: SessionLogMessage[], extra: Partial<SessionLog> = {}): SessionLog {
  return {
    schema: 'kortix.session/2', v: 1, session_id: 'session-1', title: null, created_at: AT, restore_grade: 'native',
    harness: { current: 'fake', history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] },
    threads: [{ schema: 'kortix.session/2', v: 1, thread_id: 'thr_root', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: AT, messages }],
    ...extra,
  }
}

/**
 * A native store of message ids. `restore` writes the log (except a `context` message, as both
 * harnesses do) and can drop what the test names; `held` answers the ids, or null when the store
 * is gone.
 */
function fakeStore(initial: string[] | null, { drops = {} as Record<string, number>, failures = 0 } = {}) {
  let ids: Set<string> | null = initial && new Set(initial)
  const restores: Array<{ log: SessionLog; seqMax?: Record<string, number> }> = []
  let failuresLeft = failures
  const port: SessionLogPort = {
    capabilities: CAPABILITIES,
    async changes() {
      return { messages: [], tombstones: [], threads: [] }
    },
    async restore(l, seqMax, readAttachment) {
      restores.push({ log: structuredClone(l), seqMax: seqMax && { ...seqMax } })
      if (failuresLeft-- > 0) throw new Error('the native write failed')
      for (const b of l.threads.flatMap((t) => t.messages.flatMap((m) => m.blocks))) if (b.type === 'attachment' && b.ref) await readAttachment?.(b.ref)
      const written = l.threads.flatMap((t) => t.messages.filter((m) => m.kind !== 'context'))
      ids = new Set(written.map((m) => m.message_id))
      const cursors: ExportCursor[] = l.threads.map((t) => ({
        thread_id: t.thread_id,
        last_seq: Math.max(-1, ...t.messages.map((m) => m.seq)),
        native_hashes: Object.fromEntries(written.filter((m) => m.thread_id === t.thread_id).map((m) => [m.message_id, `h-${m.message_id}`])),
      }))
      return { cursors, dropped: drops }
    },
    async held() {
      return ids
    },
    live: () => null,
  }
  return { port, restores, ids: () => ids }
}


/** The fake API. Each route answers from its queue (the last answer repeats); every request is recorded. */
function fakeApi(routes: { manifest?: Response[]; restore?: Response[]; attachment?: (id: string) => Response }) {
  const requests: string[] = []
  const journal: SessionLogJournalRequest[] = []
  const take = (queue: Response[] | undefined, i: number): Response => queue?.[Math.min(i, queue.length - 1)]?.clone() as Response ?? new Response('no route', { status: 500 })
  const count = { manifest: 0, restore: 0, claimed: 0 }
  /** The persisted `claiming` mark as each restore POST arrives. */
  const marks: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      expect(request.headers.get('authorization')).toBe('Bearer session-token')
      if (url.pathname.endsWith('/log/manifest')) return take(routes.manifest, count.manifest++)
      if (url.pathname.endsWith('/log/restore')) {
        marks.push(existsSync(sessionLogBootStatePath()) ? state().claiming : undefined)
        // claimSessionLog commits the claim before the answer leaves the API, whatever the answer is.
        const answer = take(routes.restore, count.restore++)
        if (answer.status !== 404 && answer.status !== 503) count.claimed++
        return answer
      }
      if (url.pathname.includes('/attachments/')) return routes.attachment?.(url.pathname.split('/').at(-1)!) ?? new Response('gone', { status: 404 })
      if (url.pathname.endsWith('/log/journal')) {
        const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))) as SessionLogJournalRequest
        journal.push(body)
        return Response.json({ acked: [...body.puts.map((p) => ({ message_id: p.message.message_id, rev: p.rev })), ...body.tombstones] })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
  return { requests, journal, count, marks }
}

const manifest = (generation: number, messages: Array<[string, boolean?]>): Response =>
  Response.json({ generation, messages: messages.map(([id, deleted = false]) => ({ message_id: id, content_hash: `sha256:${id}`, rev: 1, deleted })) } satisfies SessionLogManifest)

const restoreAnswer = (generation: number, l: SessionLog, extra: Partial<SessionLogRestore> = {}): Response =>
  Response.json({ generation, log: l, revs: {}, seq_max: { thr_root: Math.max(0, ...l.threads[0]!.messages.map((m) => m.seq)) }, blobs: [], ...extra } satisfies SessionLogRestore)

const STORED = log([message('m1', 1, 'one', { role: 'user' }), message('m2', 2, 'two')])
const LIVE: Array<[string]> = [['m1'], ['m2']]
const state = () => JSON.parse(readFileSync(sessionLogBootStatePath(), 'utf8'))
const RETRY = { retryMs: 1 }
/** What a restore of a log with no history (named `fake`) hands the journal: the log's harness from seq 1, this box's from `from_seq`. */
const carry = (from_seq: number) => ({ history: [{ harness: 'fake', version: 'unknown', from_seq: 1, at: AT }], from_seq, at: expect.any(String) })

describe('the boot reconcile: when the boot restores (P6.4)', () => {
  test('no native state: the box restores, journals at the claimed generation with the cursors restore returned, and persists the generation', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    const store = fakeStore(null)

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.requests).toEqual(['GET /v1/projects/project-1/sessions/session-1/log/manifest', 'POST /v1/projects/project-1/sessions/session-1/log/restore'])
    expect(store.restores).toHaveLength(1)
    expect(store.restores[0]!.seqMax).toEqual({ thr_root: 2 })
    expect(boot).toEqual({ generation: 1, cursors: [{ thread_id: 'thr_root', last_seq: 2, native_hashes: { m1: 'h-m1', m2: 'h-m2' } }], harness: carry(3) })
    expect(state()).toEqual({ version: 1, generation: 1, unwritten: [], harness: carry(3) })
  })

  test('413 session_log_too_large: the claimed generation, the root alone with the D3 note above seq_max, every stored id unwritten; the restart restores nothing', async () => {
    const child = { ...STORED.threads[0]!, thread_id: 'thr_child', parent_thread_id: 'thr_root', messages: [] }
    const bare = { ...STORED, threads: [{ ...STORED.threads[0]!, messages: [] }, child] }
    const tooLarge = Response.json(
      { generation: 1, log: bare, revs: { m1: 1, m2: 1, m0: 1 }, seq_max: { thr_root: 7, thr_child: 3 }, blobs: [], error: 'session_log_too_large', bytes: 38_588_834, limit: 24 * 1024 * 1024, messages: 2 } satisfies SessionLogRestoreTooLarge,
      { status: 413 },
    )
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [tooLarge] })
    const store = fakeStore(null)

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.count.restore).toBe(1)
    const written = store.restores.at(-1)!.log
    expect(written.threads.map((t) => t.thread_id)).toEqual(['thr_root'])
    expect(written.threads[0]!.messages).toEqual([expect.objectContaining({ seq: 8, origin: 'notification', blocks: [expect.objectContaining({ id: 'prt_kortix_restore_g1' })] })])
    expect((written.threads[0]!.messages[0]!.blocks[0] as { text: string }).text).toBe(
      'Kortix: this session was restored from its saved session log. Its earlier conversation (2 messages, 36.8 MiB) is above the 24 MiB restore limit and was not restored. If you need it, ask the user to send it again.',
    )
    expect(boot).toMatchObject({ generation: 1, session: { restore_grade: 'partial', ext: { kortix: { data: { restore: { generation: 1, dropped: { message: 2 }, truncated: 0 } } } } } })
    expect(state()).toMatchObject({ generation: 1, unwritten: ['m1', 'm2', 'm0'] })

    resetSessionLogJournalForTests()
    const again = fakeApi({ manifest: [manifest(1, LIVE)] })
    expect(await reconcileSessionLog(store.port, RETRY)).toMatchObject({ generation: 1, cursors: [] })
    expect(again.count.restore).toBe(0)
  })

  /** A 413 that carries a part of the log (`kept`), as the API answers a log over its cap. */
  const overCap = (l: SessionLog, kept: 'model_view' | 'newest', revs: Record<string, number>, seq_max: Record<string, number>, messages: number) =>
    Response.json(
      { generation: 1, log: l, revs, seq_max, blobs: [], error: 'session_log_too_large', bytes: 38_588_834, limit: 24 * 1024 * 1024, messages, kept } satisfies SessionLogRestoreTooLarge,
      { status: 413 },
    )

  test('413 kept model_view: the box writes the threads as sent, adds no note and no dropped.message, and leaves the session grade alone; every other stored id is unwritten; the restart restores nothing', async () => {
    const child = { ...STORED.threads[0]!, thread_id: 'thr_child', parent_thread_id: 'thr_root', messages: [message('c1', 1, 'child one', { thread_id: 'thr_child', role: 'user' })] }
    const slice = { ...STORED, threads: [STORED.threads[0]!, child] }
    const live: Array<[string]> = [['m0'], ['m1'], ['m2'], ['c0'], ['c1']]
    const api = fakeApi({ manifest: [manifest(0, live)], restore: [overCap(slice, 'model_view', { m0: 1, m1: 1, m2: 1, c0: 1, c1: 1 }, { thr_root: 2, thr_child: 1 }, 2)] })
    const store = fakeStore(null)

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.count.restore).toBe(1)
    // One write: no note follows.
    expect(store.restores).toHaveLength(1)
    expect(store.restores[0]!.log.threads.map((t) => [t.thread_id, t.messages.map((m) => m.message_id)])).toEqual([['thr_root', ['m1', 'm2']], ['thr_child', ['c1']]])
    expect(store.restores[0]!.seqMax).toEqual({ thr_root: 2, thr_child: 1 })
    expect(boot).toEqual({
      generation: 1,
      cursors: [
        { thread_id: 'thr_root', last_seq: 2, native_hashes: { m1: 'h-m1', m2: 'h-m2' } },
        { thread_id: 'thr_child', last_seq: 1, native_hashes: { c1: 'h-c1' } },
      ],
      harness: carry(3),
    })
    expect(state()).toEqual({ version: 1, generation: 1, unwritten: ['m0', 'c0'], harness: carry(3) })

    resetSessionLogJournalForTests()
    const again = fakeApi({ manifest: [manifest(1, live)] })
    expect(await reconcileSessionLog(store.port, RETRY)).toMatchObject({ generation: 1, cursors: [] })
    expect(again.count.restore).toBe(0)
  })

  test('413 kept model_view keeps the writer\'s own losses: a dropped attachment still gets the D3 note, without dropped.message', async () => {
    const api = fakeApi({ manifest: [manifest(0, [['m0'], ...LIVE])], restore: [overCap(STORED, 'model_view', { m0: 1, m1: 1, m2: 1 }, { thr_root: 2 }, 1)] })
    const store = fakeStore(null, { drops: { attachment: 1 } })

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.count.restore).toBe(1)
    expect((store.restores.at(-1)!.log.threads[0]!.messages.at(-1)!.blocks[0] as { text: string }).text).toBe(
      'Kortix: this session was restored from its saved session log. Some earlier content could not be restored: 1 attachment. If you need it, ask the user to send it again.',
    )
    expect(boot?.session).toMatchObject({ restore_grade: 'partial', ext: { kortix: { data: { restore: { dropped: { attachment: 1 } } } } } })
  })

  test('413 kept newest: the box writes the newest turns and a D3 note that names the earlier messages left out; the session patch is partial', async () => {
    const newest = log([message('m3', 3, 'three', { role: 'user' }), message('m4', 4, 'four')])
    const api = fakeApi({ manifest: [manifest(0, [...LIVE, ['m3'], ['m4']])], restore: [overCap(newest, 'newest', { m1: 1, m2: 1, m3: 1, m4: 1 }, { thr_root: 4 }, 2)] })
    const store = fakeStore(null)

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.count.restore).toBe(1)
    const written = store.restores.at(-1)!.log.threads[0]!.messages
    expect(written.map((m) => m.message_id).slice(0, 2)).toEqual(['m3', 'm4'])
    expect(written[2]).toEqual(expect.objectContaining({ seq: 5, origin: 'notification', blocks: [expect.objectContaining({ id: 'prt_kortix_restore_g1' })] }))
    expect((written[2]!.blocks[0] as { text: string }).text).toBe(
      'Kortix: this session was restored from its saved session log. Its 2 earliest messages were not restored: the conversation (36.8 MiB) is above the 24 MiB restore limit, and the newest messages that fit were restored. If you need it, ask the user to send it again.',
    )
    expect(boot).toMatchObject({ generation: 1, session: { restore_grade: 'partial', ext: { kortix: { data: { restore: { generation: 1, dropped: { message: 2 }, truncated: 0 } } } } } })
    expect(state()).toMatchObject({ generation: 1, unwritten: ['m1', 'm2'] })

    resetSessionLogJournalForTests()
    const again = fakeApi({ manifest: [manifest(1, [...LIVE, ['m3'], ['m4']])] })
    expect(await reconcileSessionLog(store.port, RETRY)).toMatchObject({ generation: 1, cursors: [] })
    expect(again.count.restore).toBe(0)
  })

  test('a 413 that is not session_log_too_large (a proxy) claims nothing: no restore, no retry, the mark is cleared', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [new Response('Request Entity Too Large', { status: 413 })] })
    const store = fakeStore(null)

    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.count.restore).toBe(1)
    expect(store.restores).toHaveLength(0)
    expect(state().claiming).toBeUndefined()
  })

  test('current native state (every live id held, same generation): no restore, the persisted generation', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    const store = fakeStore(['m1', 'm2'])

    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.requests).toEqual(['GET /v1/projects/project-1/sessions/session-1/log/manifest'])
    expect(store.restores).toHaveLength(0)
  })

  test('stale native state (the log holds a message the store lacks): the box restores', async () => {
    const api = fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [restoreAnswer(1, log([...STORED.threads[0]!.messages, message('m3', 3, 'three')]))] })
    const store = fakeStore(['m1', 'm2'])

    const boot = await reconcileSessionLog(store.port, RETRY)

    expect(api.count.restore).toBe(1)
    expect(boot?.generation).toBe(1)
    expect([...store.ids()!]).toEqual(['m1', 'm2', 'm3'])
  })

  test('stale by generation: another box claimed the session after this box last wrote; the box restores', async () => {
    fakeApi({ manifest: [manifest(2, LIVE)], restore: [restoreAnswer(3, STORED)] })
    const store = fakeStore(['m1', 'm2'])

    expect((await reconcileSessionLog(store.port, RETRY))?.generation).toBe(3)
    expect(store.restores).toHaveLength(1)
  })

  test('native ahead (unsent work: a message the log lacks, a tombstone the log holds): no restore', async () => {
    // m2 is tombstoned in the log and gone from the store; m9 is this box's unsent turn.
    const api = fakeApi({ manifest: [manifest(0, [['m1'], ['m2', true]])] })
    const store = fakeStore(['m1', 'm9'])

    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.count.restore).toBe(0)
  })

  test('an empty log restores nothing, even into an empty store', async () => {
    const api = fakeApi({ manifest: [manifest(0, [['m1', true]])] })
    expect(await reconcileSessionLog(fakeStore(null).port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.count.restore).toBe(0)
  })

  test('the generation survives a daemon restart, and a message the restore did not write (a context record) never reads as behind', async () => {
    const withContext = log([message('ctx', 1, 'system prompt', { role: 'system', kind: 'context' }), ...STORED.threads[0]!.messages.map((m) => ({ ...m, seq: m.seq + 1 }))])
    const api = fakeApi({ manifest: [manifest(4, [['ctx'], ...LIVE])], restore: [restoreAnswer(5, withContext)] })
    const store = fakeStore(null)

    expect((await reconcileSessionLog(store.port, RETRY))?.generation).toBe(5)
    expect(state()).toEqual({ version: 1, generation: 5, unwritten: ['ctx'], harness: carry(4) })

    // The restart: the manifest now names the claimed generation; the store holds what it wrote.
    resetSessionLogJournalForTests()
    const again = fakeApi({ manifest: [manifest(5, [['ctx'], ...LIVE])] })
    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 5, cursors: [], harness: carry(4) })
    expect(again.count.restore).toBe(0)
    expect(api.count.restore).toBe(1)
  })

  test('flag off: no manifest read, no restore; the box journals at its persisted generation', async () => {
    delete process.env.KORTIX_SESSION_LOG_RESTORE
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    const store = fakeStore(null)

    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.requests).toEqual([])

    // A box that restored while the flag was on keeps posting at its generation after the flag goes off.
    process.env.KORTIX_SESSION_LOG_RESTORE = '1'
    fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(7, STORED)] })
    expect((await reconcileSessionLog(fakeStore(null).port, RETRY))?.generation).toBe(7)
    process.env.KORTIX_SESSION_LOG_RESTORE = '0'
    const off = fakeApi({})
    expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 7, cursors: [], harness: carry(3) })
    expect(off.requests).toEqual([])
  })

  test('no control plane: nothing is read and no journal starts', async () => {
    delete process.env.KORTIX_TOKEN
    expect(await reconcileSessionLog(fakeStore(null).port, RETRY)).toBeNull()
  })

  test('a manifest the API does not serve (404, 503 ingest off) skips the reconcile', async () => {
    for (const status of [404, 503]) {
      const api = fakeApi({ manifest: [new Response('{}', { status })] })
      expect(await reconcileSessionLog(fakeStore(null).port, RETRY)).toEqual({ generation: 0, cursors: [] })
      expect(api.count.restore).toBe(0)
    }
  })

  test('a restore answer of 404 (no stored log) or 503 (restore switched off) claims nothing: no native write', async () => {
    for (const status of [404, 503]) {
      const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [new Response('{}', { status })] })
      const store = fakeStore(null)
      expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
      expect(api.count.restore).toBe(1)
      expect(store.restores).toHaveLength(0)
    }
  })

  test('a failed restore is retried (each attempt claims again); after 3 failures the boot fails and no journal can start', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [new Response('boom', { status: 500 }), restoreAnswer(1, STORED), restoreAnswer(2, STORED)] })
    const store = fakeStore(null, { failures: 1 })
    // 500, then a native write that throws, then success at the third claim.
    expect((await reconcileSessionLog(store.port, RETRY))?.generation).toBe(2)
    expect(api.count.restore).toBe(3)

    const failing = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(3, STORED)] })
    const broken = fakeStore(null, { failures: 99 })
    await expect(reconcileSessionLog(broken.port, RETRY)).rejects.toThrow('the native write failed')
    expect(failing.count.restore).toBe(3)
    // Nothing was persisted for the failed claims: the next boot still reads the store as behind.
    expect(state().generation).toBe(2)
  })

  test('no native store and a manifest that cannot be read after 3 attempts: the boot fails', async () => {
    const api = fakeApi({ manifest: [new Response('down', { status: 500 })] })
    await expect(reconcileSessionLog(fakeStore(null).port, RETRY)).rejects.toThrow(/manifest/)
    expect(api.count.manifest).toBe(3)
  })

  test('a current store and a manifest that cannot be read (500, then a body that does not parse): the box boots on its native store', async () => {
    for (const answer of [new Response('down', { status: 500 }), Response.json({ generation: 'x' })]) {
      const api = fakeApi({ manifest: [answer] })
      const store = fakeStore(['m1', 'm2'])
      expect(await reconcileSessionLog(store.port, RETRY)).toEqual({ generation: 0, cursors: [] })
      expect(api.count.manifest).toBe(3)
      expect(store.restores).toHaveLength(0)
    }
  })

  test('a brand-new session (no store, the manifest 404s): the box boots empty, as before', async () => {
    const api = fakeApi({ manifest: [new Response('{}', { status: 404 })] })
    expect(await reconcileSessionLog(fakeStore(null).port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.requests).toEqual(['GET /v1/projects/project-1/sessions/session-1/log/manifest'])
  })

  test('a stale store and a restore that claims, then fails 3 times: the boot fails (keeping the store would post below the claim); nothing is persisted', async () => {
    const api = fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 })] })
    const store = fakeStore(['m1', 'm2'])
    await expect(reconcileSessionLog(store.port, RETRY)).rejects.toThrow(/restore failed after 3 attempts/)
    expect(api.count.claimed).toBe(3)
    expect(store.restores).toHaveLength(0)
    // A native write that throws, with the store still readable: the same.
    const again = fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [restoreAnswer(1, STORED)] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2'], { failures: 99 }).port, RETRY)).rejects.toThrow(/the native write failed/)
    expect(again.count.claimed).toBe(3)
    // Only the mark the POSTs left: the generation is still the one this box wrote at.
    expect(state()).toEqual({ version: 1, generation: 0, unwritten: [], claiming: true })
  })

  test('the claiming mark is on disk before the restore POST: a box that claimed and died fails its next boot when the manifest cannot be read, even with a store', async () => {
    const stale: Array<[string]> = [...LIVE, ['m3']]
    // Boot 1: every restore POST claims, then fails (or the box dies before the answer lands).
    const first = fakeApi({ manifest: [manifest(0, stale)], restore: [new Response('down', { status: 502 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow(/restore failed/)
    expect(first.marks).toEqual([true, true, true])

    // Boot 2: the manifest is down. The store is below the claim the API holds (generation 3): the boot fails, and no journal posts below it.
    const down = fakeApi({ manifest: [new Response('down', { status: 500 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow(/manifest/)
    expect(down.count.restore).toBe(0)

    // Boot 3: the manifest answers above this box's generation; the box restores, and the mark is gone.
    fakeApi({ manifest: [manifest(3, stale)], restore: [restoreAnswer(4, log([...STORED.threads[0]!.messages, message('m3', 3, 'three')]))] })
    expect((await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY))?.generation).toBe(4)
    expect(state().claiming).toBeUndefined()
  })

  test('a 503 after an attempt that may have claimed (502, then 503 from the edge) settles nothing: the mark stays and the boot fails', async () => {
    const api = fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 }), new Response('{}', { status: 503 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow(/restore failed/)
    expect(api.count.claimed).toBe(1)
    expect(state()).toEqual({ version: 1, generation: 0, unwritten: [], claiming: true })
  })

  test('while the mark stands, a manifest that answers 403/404 boots on the store and keeps the mark', async () => {
    fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow()
    for (const status of [403, 404]) {
      const api = fakeApi({ manifest: [new Response('{}', { status })] })
      expect(await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).toEqual({ generation: 0, cursors: [] })
      expect(api.count.restore).toBe(0)
      expect(state().claiming).toBe(true)
    }
  })

  test('the ingest kill switch (503 manifest) with the mark: the box boots and keeps the mark; the next boot with a readable manifest above it restores and clears it', async () => {
    fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow()
    const off = fakeApi({ manifest: [new Response('{}', { status: 503 })] })
    expect(await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(off.count.restore).toBe(0)
    expect(state().claiming).toBe(true)
    const on = fakeApi({ manifest: [manifest(3, [...LIVE, ['m3']])], restore: [restoreAnswer(4, log([...STORED.threads[0]!.messages, message('m3', 3, 'three')]))] })
    expect((await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY))?.generation).toBe(4)
    expect(on.count.restore).toBe(1)
    expect(state().claiming).toBeUndefined()
  })

  test('a manifest above this box\'s generation whose messages are all tombstoned restores; it does not clear the mark as current', async () => {
    fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow()
    const api = fakeApi({ manifest: [manifest(3, [['m1', true], ['m2', true]])], restore: [restoreAnswer(4, log([]))] })
    expect((await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY))?.generation).toBe(4)
    expect(api.count.restore).toBe(1)
    expect(state().claiming).toBeUndefined()
  })

  test('a claiming mark the manifest shows no claim for (the POST never reached the API) is cleared; a 404/503 restore answer clears it too', async () => {
    fakeApi({ manifest: [manifest(0, [...LIVE, ['m3']])], restore: [new Response('down', { status: 502 })] })
    await expect(reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).rejects.toThrow()
    // The manifest still names generation 0 and the store holds every live id: nothing to restore, no claim stands.
    fakeApi({ manifest: [manifest(0, LIVE)] })
    expect(await reconcileSessionLog(fakeStore(['m1', 'm2']).port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(state()).toEqual({ version: 1, generation: 0, unwritten: [] })

    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [new Response('{}', { status: 404 })] })
    expect(await reconcileSessionLog(fakeStore(null).port, RETRY)).toEqual({ generation: 0, cursors: [] })
    expect(api.marks).toEqual([true])
    expect(state().claiming).toBeUndefined()
  })
})

describe('a partial restore (D3): a note for the agent and a notice for the user', () => {
  test('dropped content: the root gets a model-visible note above the seq floor, sent by the journal, and the session patch says partial', async () => {
    fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    const store = fakeStore(null, { drops: { attachment: 2 } })

    const boot = await reconcileSessionLog(store.port, RETRY)

    // The second write carries the note: a user message after every seq the API holds.
    const written = store.restores.at(-1)!.log.threads[0]!.messages
    const note = written.at(-1)!
    expect(note).toMatchObject({ role: 'user', kind: 'turn', origin: 'notification', in_context: true, seq: 3, thread_id: 'thr_root' })
    // A wire id, so hosts that order placed messages by id show it in place.
    expect(note.message_id).toMatch(WIRE_MESSAGE_ID)
    expect(note.blocks).toEqual([{ type: 'text', id: 'prt_kortix_restore_g1', text: expect.stringContaining('2 attachments') }])
    // Its cursor entry is gone, so the journal's first collection sends the note as the store holds it.
    expect(boot!.cursors[0]!.native_hashes).toEqual({ m1: 'h-m1', m2: 'h-m2' })
    expect(boot!.session).toEqual({ restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 2 }, ext: { kortix: { version: '1', data: { restore: { generation: 1, dropped: { attachment: 2 }, truncated: 0 } } } } })
    expect(state().session).toEqual(boot!.session)
  })

  test('a text the box could not read in full (truncated) and a partial log grade also make the restore partial', async () => {
    const big = message('m2', 2, 'preview…')
    ;(big.blocks[0] as { ref?: string; bytes?: number }).ref = 'kortix-attachment://project-1/session-1/obj-1'
    ;(big.blocks[0] as { ref?: string; bytes?: number }).bytes = 300_000
    const l = log([STORED.threads[0]!.messages[0]!, big], { restore_grade: 'partial', grade_counts: { tool_input: 1, cut_point: 0, attachment: 0 } })
    fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, l, { blobs: [{ message_id: 'm2', block_id: 'm2-b1', ref: 'kortix-attachment://project-1/session-1/obj-1', sha256: 'f'.repeat(64), bytes: 300_000 }] })] })

    const boot = await reconcileSessionLog(fakeStore(null).port, RETRY)

    expect(boot!.session?.restore_grade).toBe('partial')
    expect(boot!.session?.grade_counts).toEqual({ tool_input: 1, cut_point: 0, attachment: 0 })
    expect((boot!.session?.ext?.kortix?.data as { restore: { truncated: number } }).restore.truncated).toBe(1)
  })

  test('a partial log that already holds an earlier note: no new note for the old loss, a new one for a new loss', async () => {
    const earlier = message('msg_0a0000000000EarlierNote0001', 3, 'Kortix: this session was restored…', { role: 'user', origin: 'notification' })
    earlier.blocks = [{ type: 'text', id: 'prt_kortix_restore_g1', text: 'Kortix: this session was restored…' }]
    const partialLog = log([...STORED.threads[0]!.messages, earlier], { restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
    fakeApi({ manifest: [manifest(1, [...LIVE, ['msg_0a0000000000EarlierNote0001']])], restore: [restoreAnswer(2, partialLog)] })
    const quiet = fakeStore(null)
    const boot = await reconcileSessionLog(quiet.port, RETRY)
    expect(quiet.restores).toHaveLength(1)
    expect(boot!.session?.restore_grade).toBe('partial')
    expect(Object.keys(boot!.cursors[0]!.native_hashes)).toEqual(['m1', 'm2', 'msg_0a0000000000EarlierNote0001'])

    fakeApi({ manifest: [manifest(2, [...LIVE, ['msg_0a0000000000EarlierNote0001']])], restore: [restoreAnswer(3, partialLog)] })
    const lossy = fakeStore(null, { drops: { attachment: 1 } })
    await reconcileSessionLog(lossy.port, RETRY)
    expect(lossy.restores).toHaveLength(2)
    expect(lossy.restores[1]!.log.threads[0]!.messages.at(-1)!.blocks[0]!.id).toBe('prt_kortix_restore_g3')
  })

  test('a complete restore of a log graded native adds no note and clears an earlier partial notice', async () => {
    fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    expect((await reconcileSessionLog(fakeStore(null, { drops: { text: 1 } }).port, RETRY))?.session?.restore_grade).toBe('partial')
    fakeApi({ manifest: [manifest(1, LIVE)], restore: [restoreAnswer(2, STORED)] })
    const store = fakeStore(null)
    const boot = await reconcileSessionLog(store.port, RETRY)
    expect(boot).toEqual({ generation: 2, cursors: [{ thread_id: 'thr_root', last_seq: 2, native_hashes: { m1: 'h-m1', m2: 'h-m2' } }], harness: carry(3) })
    expect(store.restores).toHaveLength(1)
    expect(state().session).toBeUndefined()
  })

  test('attachment bytes are read while the texts are read, and the native write gets them', async () => {
    const seen: string[] = []
    const withImage = log([message('m1', 1, 'look', { role: 'user', blocks: [{ type: 'attachment', id: 'a1', mime: 'image/png', ref: 'kortix-attachment://project-1/session-1/img-1' }] as never })])
    fakeApi({
      manifest: [manifest(0, [['m1']])],
      restore: [restoreAnswer(1, withImage)],
      attachment: (id) => {
        seen.push(id)
        return new Response(new Uint8Array([1, 2, 3]))
      },
    })
    await reconcileSessionLog(fakeStore(null).port, RETRY)
    // Once: the native write reads the prefetched bytes, not the API.
    expect(seen).toEqual(['img-1'])
  })

  test('the journal sets the notice on every session patch it sends', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, STORED)] })
    const port: SessionLogPort = {
      ...fakeStore(null).port,
      async changes() {
        return { messages: [], tombstones: [], threads: [], session: { title: 'A synthetic title', restore_grade: 'native' } }
      },
    }
    const journal = new SessionLogJournal(port, { generation: 1, session: { restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } } })
    expect(await journal.flush()).toBe(true)
    expect(api.journal[0]!.session).toEqual({ title: 'A synthetic title', restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
  })
})

describe('the harness history across a switch (P7.1)', () => {
  const OPENCODE = { harness: 'opencode', version: '1.18.23', from_seq: 1, at: AT }
  const opencodeLog = log(STORED.threads[0]!.messages, { harness: { current: 'opencode', history: [OPENCODE] } })
  /** A box of `harness` whose export names only itself, as both adapters do. */
  const box = (harness: string, version: string): SessionLogPort => ({
    ...fakeStore(null).port,
    async changes() {
      return { messages: [], tombstones: [], threads: [], session: { harness: { current: harness, history: [{ harness, version, from_seq: 1, at: AT }] } } }
    },
  })
  const sent = async (port: SessionLogPort, boot: Awaited<ReturnType<typeof reconcileSessionLog>>, api: ReturnType<typeof fakeApi>) => {
    expect(await new SessionLogJournal(port, boot!).flush()).toBe(true)
    return api.journal.at(-1)!.session!.harness
  }

  test('an OpenCode log restored into a pi box: the journal sends the OpenCode entry and a pi entry from the first seq after the restore, at every boot', async () => {
    const api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, opencodeLog)] })
    const port = box('pi', '1.0.3')
    const boot = await reconcileSessionLog(port, RETRY)
    const harness = await sent(port, boot, api)
    expect(harness).toEqual({ current: 'pi', history: [OPENCODE, { harness: 'pi', version: '1.0.3', from_seq: 3, at: expect.any(String) }] })

    // A daemon restart (no restore): the persisted carry gives the same history.
    resetSessionLogJournalForTests()
    const again = fakeApi({ manifest: [manifest(1, LIVE)] })
    const restarted = await reconcileSessionLog(port, RETRY)
    expect(again.count.restore).toBe(0)
    expect(await sent(port, restarted, again)).toEqual(harness)
  })

  test('the same harness (a new version too) adds no entry; a log that already switched keeps its whole history', async () => {
    let api = fakeApi({ manifest: [manifest(0, LIVE)], restore: [restoreAnswer(1, opencodeLog)] })
    let port = box('opencode', '1.18.24')
    expect(await sent(port, await reconcileSessionLog(port, RETRY), api)).toEqual({ current: 'opencode', history: [OPENCODE] })

    resetSessionLogJournalForTests()
    const switched = { current: 'pi', history: [OPENCODE, { harness: 'pi', version: '1.0.3', from_seq: 3, at: AT }] }
    api = fakeApi({ manifest: [manifest(2, LIVE)], restore: [restoreAnswer(3, log(STORED.threads[0]!.messages, { harness: switched }))] })
    port = box('pi', '1.0.3')
    expect(await sent(port, await reconcileSessionLog(port, RETRY), api)).toEqual(switched)
  })

  test('a box that never restored sends the history its adapter exports', async () => {
    delete process.env.KORTIX_SESSION_LOG_RESTORE
    const api = fakeApi({})
    const port = box('pi', '1.0.3')
    expect(await sent(port, await reconcileSessionLog(port, RETRY), api)).toEqual({ current: 'pi', history: [{ harness: 'pi', version: '1.0.3', from_seq: 1, at: AT }] })
  })
})
