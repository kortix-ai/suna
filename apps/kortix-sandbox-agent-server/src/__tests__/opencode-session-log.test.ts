/**
 * The OpenCode session-log adapter (P2.6) on a REAL OpenCode 1.18.23 store.
 *
 * `fixtures/opencode-session-log.json` holds the rows `opencode serve` wrote
 * against a mock LLM (synthetic prompts): text, reasoning, todowrite and bash,
 * a user image, a failing bash, a manual compaction, a `task` sub-agent, a
 * bash call stopped mid-run, then a revert of the last turn and a new prompt
 * (`before` and `after`). Beside each store it holds the v1 mirror rows the
 * API's capture stores for it (kortixd's proxy strip, then apps/api
 * `mirrorRowsFromOpencodePayload`), so the `fromV1` equality runs against what
 * the API's own conversion (P2.7, P3.1) will read.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AdapterCapabilitiesSchema,
  fromV1,
  toV1,
  SESSION_LOG_EVENTS,
  SessionLogJournalRequestSchema,
  upcast,
  type ExportCursor,
  type SessionLog,
  type SessionLogMessage,
  type V1Row,
} from '@kortix/api-contract/session-log'
import { createOpenCodeSessionLogPort, OPENCODE_CAPABILITIES, openCodeSessionLog, bootOpenCodeSessionLog, type SeqState } from '@/harness/open-code/session-log'
import { OpencodeDb, type StoreSnapshot } from '@/harness/open-code/opencode-db'
import { OFFLOAD_PLACEHOLDER_URL } from '@/harness/open-code/attachment-offload'
import { composeOpenCodeHarnessService } from '@/harness/open-code/service'
import { readOpenCodeSessionPin, writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { flushSessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'
import { kortixEventBus, resetKortixEventBusForTests, sessionLogEventBus, type KortixEvent } from '@/services/event-bus/kortix-event-bus'
import { testOpenCodeConfig } from './helpers/open-code-harness'
import fixture from './fixtures/opencode-session-log.json'

const SESSION = 'session-oc-log'
const ROOT = fixture.root
const CHILD = fixture.children[0]!
const before = fixture.before as StoreSnapshot
const after = fixture.after as StoreSnapshot
const v1Before = fixture.v1Before as unknown as V1Row[]
const v1After = fixture.v1After as unknown as V1Row[]
const PNG_SHA = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77'

const exported = (store: StoreSnapshot, seqs: SeqState = {}) => openCodeSessionLog({ sessionId: SESSION, rootId: ROOT, store, seqs })
const all = (log: SessionLog) => log.threads.flatMap((t) => t.messages)
const roleOf = (store: StoreSnapshot, id: string) => (JSON.parse(store.messages.find((m) => m.id === id)!.data) as { role: string; summary?: boolean })

/**
 * The fields only the daemon knows (the module header of `session-log.ts`),
 * removed so the rest compares with `fromV1`: seq, producer, an attachment's
 * ref/bytes/sha256 (and the `kortix-attachment://` url the API's capture adds
 * on a live box; the fixture's mirror rows have none), and the session and
 * thread fields the store adds.
 */
function withoutDaemonFields(log: SessionLog): unknown {
  const copy = structuredClone(log) as SessionLog & Record<string, unknown>
  for (const key of ['title', 'created_at', 'restore_grade', 'grade_counts', 'harness', 'todos'] as const) delete copy[key]
  for (const thread of copy.threads) {
    thread.title = null
    for (const m of thread.messages) {
      delete (m as Partial<SessionLogMessage>).seq
      delete (m as Partial<SessionLogMessage>).producer
      for (const b of m.blocks) {
        if (b.type === 'attachment') {
          delete b.ref
          delete b.bytes
          delete b.sha256
        }
        if (b.type === 'tool_call') for (const c of b.result?.content ?? []) if (c.type === 'attachment') delete c.ref, delete c.sha256
      }
    }
  }
  return copy
}

/**
 * A sqlite file with the 1.18.23 tables the reader needs, holding `store`. A
 * second call replaces the rows in place, as OpenCode's own writes do: the
 * reader keeps its connection open.
 */
function writeStore(path: string, store: StoreSnapshot): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
    CREATE TABLE IF NOT EXISTS todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL, position integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    DELETE FROM session; DELETE FROM message; DELETE FROM part; DELETE FROM todo;
  `)
  for (const s of store.sessions) db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, 'prj', s.parent_id, s.id, '/workspace', s.title, s.version, s.time_created, s.time_created)
  for (const m of store.messages) db.query('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(m.id, m.session_id, m.time_created, m.time_updated, m.data)
  for (const p of store.parts) db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data)
  for (const t of store.todos) db.query('INSERT INTO todo VALUES (?, ?, ?, ?, ?, 0, 0)').run(t.session_id, t.content, t.status, t.priority, t.position)
  db.close()
}

/** One cursor per thread, as the journal keeps them after a collection. */
function cursorsOf(messages: Array<{ message: SessionLogMessage; native_hash: string }>): ExportCursor[] {
  const threads = [...new Set(messages.map((m) => m.message.thread_id))]
  return threads.map((thread_id) => {
    const mine = messages.filter((m) => m.message.thread_id === thread_id)
    return { thread_id, last_seq: Math.max(...mine.map((m) => m.message.seq)), native_hashes: Object.fromEntries(mine.map((m) => [m.message.message_id, m.native_hash])) }
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-session-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('OpenCode session-log export: one mapping with fromV1', () => {
  test('the records equal fromV1 of the mirror rows of the same store, apart from the daemon-only fields', () => {
    for (const [store, rows] of [[before, v1Before], [after, v1After]] as const) {
      const ours = exported(store).log
      const theirs = fromV1({ session_id: SESSION, root_id: ROOT, rows }, { harness: 'opencode' })
      expect(withoutDaemonFields(ours)).toEqual(withoutDaemonFields(theirs))
      // A fresh export of a store with no revert numbers like fromV1.
      expect(all(ours).map((m) => m.seq)).toEqual(all(theirs).map((m) => m.seq))
    }
  })

  test('toV1 of the journaled record gives back the mirror rows the capture stores (P4.2)', () => {
    const byId = (rows: V1Row[]) => [...rows].sort((a, b) => (a.info.id < b.info.id ? -1 : 1))
    for (const [store, rows] of [[before, v1Before], [after, v1After]] as const) {
      const out = toV1(JSON.parse(JSON.stringify(exported(store).log)))
      expect(out.root_id).toBe(ROOT)
      expect(byId(out.rows)).toEqual(byId(JSON.parse(JSON.stringify(rows))))
    }
  })

  test('the daemon-only fields: producer, image bytes, store title, todos, native grade', () => {
    const { log } = exported(after)
    for (const m of all(log)) expect(m.producer).toEqual({ harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' })
    const image = all(log).flatMap((m) => m.blocks).find((b) => b.type === 'attachment')
    expect(image).toEqual({ type: 'attachment', id: expect.stringMatching(/^prt_/), mime: 'image/png', name: 'dot.png', ref: `blob:${PNG_SHA}`, bytes: 70, sha256: PNG_SHA })
    expect(JSON.stringify(log)).not.toContain('data:image/png')
    expect(log).toMatchObject({
      title: 'Fixture session', restore_grade: 'native', harness: { current: 'opencode', history: [{ harness: 'opencode', version: '1.18.23', from_seq: 1 }] },
      todos: [{ content: 'Create hello.txt', status: 'completed', priority: 'high' }, { content: 'Check the image', status: 'pending', priority: 'medium' }],
    })
    expect(log.grade_counts).toBeUndefined()
    expect(log.threads.map((t) => t.title)).toEqual(['Fixture session', 'list files (@general subagent)'])
  })

  test('every record passes upcast(), and the capabilities validate', () => {
    for (const store of [before, after]) expect(() => upcast(exported(store).log)).not.toThrow()
    expect(AdapterCapabilitiesSchema.parse(OPENCODE_CAPABILITIES)).toBeTruthy()
  })

  test('message ids are the store ids, block ids the part ids; a summary row folds into its compaction', () => {
    const { log } = exported(after)
    const summaries = after.messages.filter((m) => roleOf(after, m.id).summary === true).map((m) => m.id)
    expect(summaries).toHaveLength(1)
    expect(all(log).map((m) => m.message_id).sort()).toEqual(after.messages.map((m) => m.id).filter((id) => !summaries.includes(id)).sort())
    for (const m of all(log)) expect(m.blocks.map((b) => b.id)).toEqual(after.parts.filter((p) => p.message_id === m.message_id).map((p) => p.id))
    const compaction = all(log).find((m) => m.kind === 'compaction')!
    expect(compaction.blocks[0]).toMatchObject({ type: 'compaction', summary: 'SUMMARY: hello.txt holds hi; false failed.', trigger: 'manual' })
  })

  test('the task child is a thread spawned by the task call; the stopped bash call is an aborted reply', () => {
    const { log } = exported(after)
    const [root, child] = log.threads
    const task = root!.messages.flatMap((m) => m.blocks.map((b) => ({ m, b }))).find(({ b }) => b.type === 'tool_call' && b.name === 'task')!
    expect(child).toMatchObject({ thread_id: CHILD, parent_thread_id: ROOT, spawned_by: { message_id: task.m.message_id, call_id: (task.b as { call_id: string }).call_id } })
    expect(child!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    const stopped = root!.messages.find((m) => m.status === 'aborted')!
    expect(stopped).toMatchObject({ error: { code: 'MessageAbortedError' }, finish: 'aborted' })
    expect(stopped.blocks.find((b) => b.type === 'tool_call')).toMatchObject({ name: 'bash', input: { command: 'sleep 30' } })
  })
})

describe('the seq rule: issued once per message, never reused, kept by a tombstone', () => {
  test('after a revert the new messages get seqs above every seq issued; position numbering would reuse one', () => {
    const seqs: SeqState = {}
    const first = all(exported(before, seqs).log)
    const second = all(exported(after, seqs).log)
    const firstSeq = new Map(first.map((m) => [m.message_id, m.seq]))
    const reverted = first.filter((m) => !second.some((x) => x.message_id === m.message_id))
    const added = second.filter((m) => !firstSeq.has(m.message_id))
    expect(reverted.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(added.map((m) => m.role)).toEqual(['user', 'assistant'])
    // Kept messages keep their seq; new ones are above every seq issued in the thread.
    for (const m of second) if (firstSeq.has(m.message_id)) expect(m.seq).toBe(firstSeq.get(m.message_id)!)
    const maxRoot = Math.max(...first.filter((m) => m.thread_id === ROOT).map((m) => m.seq))
    expect(added.map((m) => m.seq)).toEqual([maxRoot + 1, maxRoot + 2])
    // fromV1 numbers by position: it hands the reverted user message's seq to the new one.
    const positional = all(fromV1({ session_id: SESSION, root_id: ROOT, rows: v1After }))
    const reusedSeq = positional.find((m) => m.message_id === added[0]!.message_id)!.seq
    expect(reusedSeq).toBe(firstSeq.get(reverted[0]!.message_id)!)
    expect(second.map((m) => m.seq)).not.toContain(reusedSeq)
    for (const t of exported(after, seqs).log.threads) for (let i = 1; i < t.messages.length; i++) expect(t.messages[i]!.seq).toBeGreaterThan(t.messages[i - 1]!.seq)
  })

  test('a restarted port reads its seqs back: same seqs, same hashes, nothing to send', async () => {
    const dbPath = join(dir, 'opencode.db')
    const statePath = join(dir, 'state', 'opencode-session-log.json')
    writeStore(dbPath, before)
    const port = () => createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath })
    const first = await port().changes([])
    // Messages first seen after the revert, then the store reverted: seqs come from the file.
    writeStore(dbPath, after)
    const restarted = port()
    const next = await restarted.changes(cursorsOf(first.messages))
    expect(next.tombstones.sort()).toEqual(before.messages.map((m) => m.id).filter((id) => !after.messages.some((m) => m.id === id)).sort())
    const maxRoot = Math.max(...first.messages.filter((m) => m.message.thread_id === ROOT).map((m) => m.message.seq))
    expect(next.messages.map((m) => m.message.seq)).toEqual([maxRoot + 1, maxRoot + 2])
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ version: 1, threads: { [ROOT]: { next: maxRoot + 3 } } })
    const again = await port().changes(cursorsOf([...first.messages, ...next.messages]))
    expect(again.messages).toEqual([])
  })

  test('a malformed data url is an unresolved attachment, never a failed export', () => {
    const store = structuredClone(after)
    const part = store.parts.find((p) => JSON.parse(p.data).type === 'file')!
    part.data = JSON.stringify({ ...JSON.parse(part.data), url: 'data:image/png,%E0%A4%A' })
    const image = all(exported(store).log).flatMap((m) => m.blocks).find((b) => b.id === part.id)
    expect(image).toEqual({ type: 'attachment', id: part.id, mime: 'image/png', name: 'dot.png' })
  })

  test('P2.13: blob() gives the bytes behind each blob: ref the last changes() exported, inline or offloaded to a sidecar', async () => {
    const dbPath = join(dir, 'opencode.db')
    const statePath = join(dir, 'state.json')
    const store = structuredClone(after)
    // A second image, offloaded: the row holds the placeholder and a marker naming the sidecar file.
    const sidecar = join(dir, 'sidecar.bin')
    const offloaded = Buffer.from('synthetic offloaded attachment bytes')
    writeFileSync(sidecar, offloaded)
    const image = store.parts.find((p) => JSON.parse(p.data).type === 'file')!
    store.parts.push({ ...image, id: `${image.id}x`, data: JSON.stringify({ ...JSON.parse(image.data), url: OFFLOAD_PLACEHOLDER_URL, kortix: { offloaded: true, sidecar } }) })
    writeStore(dbPath, store)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath })
    const refs = (await port.changes([])).messages.flatMap((m) => m.message.blocks.flatMap((b) => (b.type === 'attachment' ? [b.ref] : [])))
    const offloadedSha = new Bun.CryptoHasher('sha256').update(offloaded).digest('hex')
    expect(refs).toEqual([`blob:${PNG_SHA}`, `blob:${offloadedSha}`])
    expect(new Bun.CryptoHasher('sha256').update(port.blob!(PNG_SHA)!).digest('hex')).toBe(PNG_SHA)
    expect(port.blob!(offloadedSha)).toEqual(offloaded)
    expect(port.blob!('0'.repeat(64))).toBeNull()
  })

  test('a corrupt seq file restarts the seqs at 1', async () => {
    const dbPath = join(dir, 'opencode.db')
    const statePath = join(dir, 'opencode-session-log.json')
    writeStore(dbPath, before)
    writeFileSync(statePath, '{not json')
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath })
    const first = await port.changes([])
    expect(first.messages.filter((m) => m.message.thread_id === ROOT)[0]!.message.seq).toBe(1)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ version: 1 })
  })

  test('native_hash is stable with no change and moves when a part changes', () => {
    const first = exported(after).hashes
    expect(exported(after).hashes).toEqual(first)
    const store = structuredClone(after)
    const part = store.parts.find((p) => JSON.parse(p.data).type === 'text')!
    part.data = JSON.stringify({ ...JSON.parse(part.data), text: 'edited' })
    const changed = exported(store).hashes
    expect([...changed].filter(([id, hash]) => first.get(id) !== hash).map(([id]) => id)).toEqual([part.message_id])
  })

  test('no pin or no store: no changes and never a tombstone', async () => {
    const dbPath = join(dir, 'opencode.db')
    const statePath = join(dir, 'state.json')
    const cursors = [{ thread_id: ROOT, last_seq: 3, native_hashes: { msg_x: 'h' } }]
    const noPin = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => null, statePath })
    expect(await noPin.changes(cursors)).toEqual({ messages: [], tombstones: [], threads: [] })
    const noStore = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath })
    expect(await noStore.changes(cursors)).toEqual({ messages: [], tombstones: [], threads: [] })
    // P6.3: a port without a restore target (binary, project directory) refuses to restore, as pi's does.
    await expect(noStore.restore({} as SessionLog)).rejects.toThrow('needs a target')
  })
})

describe('OpenCode session-log journal wiring', () => {
  const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_SESSION_LOG_DUMP_DIR', 'KORTIX_RUNTIME_STATE_DIR'] as const
  let saved: Record<string, string | undefined> = {}
  let dump: string
  /** Dumped batches in write order (`batch-<ms>-<n>.json`; readdir order is the file system's). */
  const dumped = () =>
    readdirSync(dump)
      .sort((a, b) => Number(/-(\d+)\.json$/.exec(a)![1]) - Number(/-(\d+)\.json$/.exec(b)![1]))
      .map((f) => SessionLogJournalRequestSchema.parse(JSON.parse(readFileSync(join(dump, f), 'utf8'))))
  beforeEach(() => {
    resetSessionLogJournalForTests()
    resetSessionTokenHealthForTests()
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    dump = join(dir, 'dump')
    process.env.KORTIX_PROJECT_ID = 'project-1'
    process.env.KORTIX_SESSION_ID = SESSION
    process.env.KORTIX_TOKEN = 'session-token'
    process.env.KORTIX_API_URL = 'http://127.0.0.1:9' // nothing listens: a post would fail the flush
    process.env.KORTIX_SESSION_LOG_DUMP_DIR = dump
    process.env.KORTIX_RUNTIME_STATE_DIR = join(dir, 'state')
  })
  afterEach(() => {
    resetSessionLogJournalForTests()
    resetSessionTokenHealthForTests()
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  test('the journal over the pinned root: one batch of the store, then the revert as tombstones', async () => {
    const dbPath = join(dir, 'opencode.db')
    writeStore(dbPath, before)
    writeOpenCodeSessionPin(ROOT)
    // The port `bootOpenCodeSessionLog` builds, on a test path: the production
    // one reads `OPENCODE_HOME` (`paths.ts`), bound to `homedir()` when the
    // module loads, and the hermetic test env does not point HOME at a test dir.
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: readOpenCodeSessionPin })
    expect(startSessionLogJournal(port, { generation: 0 })).not.toBeNull()
    expect(await flushSessionLogJournal()).toBe(true)
    const [first] = dumped()
    expect(first!.generation).toBe(0)
    expect(first!.puts.map((p) => p.message.message_id).sort()).toEqual(all(exported(before).log).map((m) => m.message_id).sort())
    expect(first!.threads.map((t) => t.thread_id)).toEqual([ROOT, CHILD])
    expect(first!.session).toMatchObject({ session_id: SESSION, restore_grade: 'native' })
    writeStore(dbPath, after)
    expect(await flushSessionLogJournal()).toBe(true)
    const second = dumped()[1]!
    expect(second.tombstones.map((t) => t.message_id).sort()).toEqual(before.messages.map((m) => m.id).filter((id) => !after.messages.some((m) => m.id === id)).sort())
    const maxRoot = Math.max(...first!.puts.filter((p) => p.message.thread_id === ROOT).map((p) => p.message.seq))
    expect(second.puts.map((p) => p.message.seq)).toEqual([maxRoot + 1, maxRoot + 2])
    expect(readFileSync(join(dir, 'state', 'opencode-session-log.json'), 'utf8')).toContain(ROOT)
  })

  test('the v2 stream: state and threads first, every journaled revision as log.message, the revert as tombstones, text deltas under the stored block id', async () => {
    resetKortixEventBusForTests()
    const frames: KortixEvent[] = []
    sessionLogEventBus().subscribe((event) => void frames.push(event), {})
    const dbPath = join(dir, 'opencode.db')
    writeStore(dbPath, before)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath: join(dir, 's.json') })
    const journal = startSessionLogJournal(port, { generation: 0 })!
    expect(await flushSessionLogJournal()).toBe(true)
    const first = dumped()[0]!
    for (const frame of frames) expect(SESSION_LOG_EVENTS[frame.type as keyof typeof SESSION_LOG_EVENTS].safeParse(frame.payload).success).toBe(true)
    // The journal start collected the store at rest: one state, one frame per thread, one per put, in that order.
    expect(frames.map((f) => f.type)).toEqual(['log.state', 'log.thread', 'log.thread', ...first.puts.map(() => 'log.message')])
    expect(frames[0]!.payload).toEqual({ generation: 0, session: first.session })
    expect(frames.slice(1, 3).map((f) => f.payload)).toEqual(first.threads)
    // Same ids, seqs and revs as the batch the API receives.
    expect(frames.slice(3).map((f) => f.payload)).toEqual(first.puts)
    expect(frames.slice(3).map((f) => f.session)).toEqual(first.puts.map((p) => p.message.thread_id))

    // A delta as OpenCode streams it names the part row: the block id is the id the record stores.
    const part = before.parts.find((p) => p.session_id === ROOT && (JSON.parse(p.data) as { type: string }).type === 'text')!
    const bus = kortixEventBus()
    bus.publish('message.part.delta', { sessionID: ROOT, messageID: part.message_id, partID: part.id, field: 'text', delta: 'more' }, ROOT)
    bus.publish('message.part.delta', { sessionID: ROOT, messageID: part.message_id, partID: part.id, field: 'metadata', delta: 'x' }, ROOT)
    bus.publish('message.part.updated', { sessionID: ROOT, part: { id: part.id } }, ROOT)
    const delta = frames.slice(3 + first.puts.length)
    expect(delta.map((f) => [f.type, f.payload])).toEqual([['log.block.delta', { thread_id: ROOT, message_id: part.message_id, block_id: part.id, delta: 'more' }]])
    const stored = first.puts.find((p) => p.message.message_id === part.message_id)!.message
    expect(stored.blocks.filter((b) => b.type === 'text').map((b) => b.id)).toContain(part.id)

    writeStore(dbPath, after)
    const seen = frames.length
    expect(await flushSessionLogJournal()).toBe(true)
    const second = dumped()[1]!
    const revert = frames.slice(seen).map((f) => f.payload as Record<string, unknown>)
    // A tombstone is the journal's own `{ message_id, rev }`: no `message`.
    expect(revert.filter((p) => !('message' in p))).toEqual(second.tombstones)
    expect(revert.filter((p) => 'message' in p)).toEqual(second.puts)
    await journal.stop(0)
    bus.publish('message.part.delta', { sessionID: ROOT, messageID: part.message_id, partID: part.id, field: 'text', delta: 'late' }, ROOT)
    expect(frames.at(-1)!.payload).not.toMatchObject({ delta: 'late' })
  })

  test.each(['text', 'reasoning'])('OpenCode snapshot updates stream %s before the turn ends', async (type) => {
    resetKortixEventBusForTests()
    const frames: KortixEvent[] = []
    sessionLogEventBus().subscribe((event) => void frames.push(event), {})
    const dbPath = join(dir, 'opencode.db')
    writeStore(dbPath, before)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath: join(dir, 's.json') })
    startSessionLogJournal(port, { generation: 0 })
    await flushSessionLogJournal()
    const bus = kortixEventBus()
    const id = 'msg_streaming_snapshot'
    bus.publish('message.updated', { info: { id, sessionID: ROOT, role: 'assistant', time: { created: 1791729213580 } } }, ROOT)
    const part = { id: 'prt_streaming_snapshot', messageID: id, sessionID: ROOT, type, text: '' }
    bus.publish('message.part.updated', { part }, ROOT)
    for (const text of ['1\n', '1\n2\n', '1\n2\n3\n']) {
      bus.publish('message.part.updated', { part: { ...part, text } }, ROOT)
      const puts = frames.filter((f) => f.type === 'log.message').map((f) => SESSION_LOG_EVENTS['log.message'].parse(f.payload)).filter((p) => 'message' in p)
      const put = puts.filter((p) => p.message?.message_id === id).at(-1)
      expect(put?.message?.status).toBe('streaming')
      expect(put?.message?.blocks.find((b) => b.id === part.id)).toMatchObject({ type, text })
    }
    const count = frames.length
    bus.publish('message.part.updated', { part: { ...part, text: '1\n2\n3\n' } }, ROOT)
    expect(frames).toHaveLength(count)
    bus.publish('message.part.delta', { sessionID: ROOT, messageID: id, partID: part.id, field: 'text', delta: '4\n' }, ROOT)
    bus.publish('message.part.updated', { part: { ...part, text: '1\n2\n3\n4\n' } }, ROOT)
    expect(frames).toHaveLength(count + 1)
    expect(frames.at(-1)?.type).toBe('log.block.delta')
    expect(part.text).toBe('')
  })

  test('a live turn (P4.3b): the user put, a streaming put before the first delta, a put for each new block, then the final put at a higher rev', async () => {
    resetKortixEventBusForTests()
    const frames: KortixEvent[] = []
    sessionLogEventBus().subscribe((event) => void frames.push(event), {})
    const dbPath = join(dir, 'opencode.db')
    writeStore(dbPath, before)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath: join(dir, 's.json') })
    startSessionLogJournal(port, { generation: 0 })
    expect(await flushSessionLogJournal()).toBe(true)
    const startFrames = frames.length

    // The new turn of the fixture, with a bash call added before its answer, as OpenCode stores it at rest.
    const fresh = after.messages.filter((m) => !before.messages.some((b) => b.id === m.id))
    const [userRow, replyRow] = fresh
    const tool = { id: 'prt_12b622097500LiveTurnToolCall', message_id: replyRow!.id, session_id: ROOT, time_created: 0, time_updated: 0, data: JSON.stringify({ type: 'tool', callID: 'call_live', tool: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi', title: 'echo hi', metadata: {}, time: { start: 1791729213580, end: 1791729213590 } } }) }
    const atRest: StoreSnapshot = { ...after, parts: [...after.parts, tool].sort((a, b) => a.id.localeCompare(b.id)) }
    const info = (row: (typeof fresh)[number]): Record<string, any> => ({ ...(JSON.parse(row.data) as Record<string, any>), id: row.id, sessionID: row.session_id })
    const partOf = (id: string): Record<string, any> => {
      const row = atRest.parts.find((p) => p.id === id)!
      return { ...(JSON.parse(row.data) as Record<string, any>), id, messageID: row.message_id, sessionID: row.session_id }
    }
    const [stepStart, text, stepFinish] = after.parts.filter((p) => p.message_id === replyRow!.id).map((p) => partOf(p.id))
    const bus = kortixEventBus()
    const emit = (type: string, payload: Record<string, unknown>) => bus.publish(type, payload, ROOT)
    // The frames OpenCode publishes for that turn, in its order.
    emit('message.updated', { sessionID: ROOT, info: info(userRow!) })
    emit('message.part.updated', { sessionID: ROOT, part: partOf(after.parts.find((p) => p.message_id === userRow!.id)!.id) })
    const open = info(replyRow!)
    emit('message.updated', { sessionID: ROOT, info: { ...open, time: { created: open.time.created }, finish: undefined } })
    emit('message.part.updated', { sessionID: ROOT, part: stepStart })
    const call = partOf(tool.id)
    emit('message.part.updated', { sessionID: ROOT, part: { ...call, state: { status: 'pending', input: {}, raw: '' } } })
    emit('message.part.updated', { sessionID: ROOT, part: { ...call, state: { status: 'running', input: call.state.input, time: { start: call.state.time.start } } } })
    emit('message.part.updated', { sessionID: ROOT, part: call })
    const empty = { ...text!, text: '' }
    emit('message.part.updated', { sessionID: ROOT, part: empty })
    for (const delta of ['After the ', 'revert.']) emit('message.part.delta', { sessionID: ROOT, messageID: replyRow!.id, partID: text!.id, field: 'text', delta })
    emit('message.part.updated', { sessionID: ROOT, part: text })
    emit('message.part.updated', { sessionID: ROOT, part: stepFinish })
    emit('message.updated', { sessionID: ROOT, info: open })
    // The live puts read nothing from the store, and never change a v1 frame: the delta did not extend the published part.
    expect(empty.text).toBe('')
    writeStore(dbPath, atRest)
    expect(await flushSessionLogJournal()).toBe(true)

    const turn = frames.slice(startFrames) as Array<{ seq: number; type: string; payload: any }>
    for (const f of turn) expect(SESSION_LOG_EVENTS[f.type as keyof typeof SESSION_LOG_EVENTS].safeParse(f.payload).success, f.type).toBe(true)
    const finals = new Map(dumped()[1]!.puts.map((p) => [p.message.message_id, p]))
    const putsOf = (id: string) => turn.filter((f) => f.type === 'log.message' && f.payload.message?.message_id === id)
    for (const row of fresh) {
      const own = putsOf(row.id)
      const final = finals.get(row.id)!
      // The API receives one record: the turn end's, the last put on the stream.
      expect(own.at(-1)!.payload).toEqual(final)
      const live = own.slice(0, -1)
      expect(live.length).toBeGreaterThan(0)
      // Seq stability: every live put carries the seq, thread and created_at of the turn end's record, at a lower rev.
      for (const f of live) {
        expect(f.payload.message).toMatchObject({ seq: final.message.seq, thread_id: ROOT, created_at: final.message.created_at })
        expect(f.payload.rev).toBeLessThan(final.rev)
      }
    }
    const replyPuts = putsOf(replyRow!.id)
    expect(putsOf(userRow!.id)[0]!.payload.message.status).toBe('complete')
    expect(putsOf(userRow!.id)[0]!.seq).toBeLessThan(replyPuts[0]!.seq)
    expect(replyPuts[0]!.payload.message).toMatchObject({ role: 'assistant', status: 'streaming', reply_to: userRow!.id, completed_at: null, blocks: [] })
    expect(replyPuts.at(-1)!.payload.message.status).toBe('complete')
    // The call: a put carries its block, pending as OpenCode announced it, with no closure result.
    const callPut = replyPuts.find((f) => f.payload.message.blocks.some((b: { id: string }) => b.id === tool.id))!
    expect(callPut.payload.message.status).toBe('streaming')
    expect(callPut.payload.message.blocks.find((b: { id: string }) => b.id === tool.id)).toMatchObject({ type: 'tool_call', status: 'pending' })
    expect(callPut.payload.message.blocks.find((b: { id: string }) => b.id === tool.id).result).toBeUndefined()
    // The text block is on the stream, empty, before its first delta; the deltas follow it.
    const deltas = turn.filter((f) => f.type === 'log.block.delta')
    expect(deltas.map((d) => d.payload.delta)).toEqual(['After the ', 'revert.'])
    const holder = replyPuts.find((f) => f.payload.message.blocks.some((b: { id: string }) => b.id === text!.id))!
    expect(holder.payload.message.blocks.find((b: { id: string }) => b.id === text!.id).text).toBe('')
    expect(holder.seq).toBeLessThan(deltas[0]!.seq)
    // The step-finish put, after the deltas, holds the text they streamed.
    const afterDeltas = replyPuts.find((f) => f.seq > deltas[1]!.seq && f !== replyPuts.at(-1))!
    expect(afterDeltas.payload.message.blocks.find((b: { id: string }) => b.id === text!.id).text).toBe('After the revert.')
    for (const p of dumped().flatMap((b) => b.puts)) expect(p.message.status).not.toBe('streaming')
  })

  test('without a control plane the boot start journals nothing', async () => {
    delete process.env.KORTIX_SESSION_ID
    expect(await bootOpenCodeSessionLog({ bin: 'opencode', cwd: dir })).toBe(false)
    expect(existsSync(dump)).toBe(false)
  })

  test('the host stop flushes the journal before OpenCode stops; a restart leaves it running', async () => {
    const dbPath = join(dir, 'opencode.db')
    writeStore(dbPath, before)
    const calls: string[] = []
    const native = {
      getInternalUrl: () => 'http://127.0.0.1:9',
      getState: () => 'ok',
      getPid: () => null,
      async stop() {
        calls.push(`stop:${existsSync(dump) ? readdirSync(dump).length : 0}`)
      },
      async restart() {
        await this.stop()
        calls.push('restart')
      },
    }
    const service = composeOpenCodeHarnessService(testOpenCodeConfig(), native as unknown as Opencode)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId: SESSION, rootId: () => ROOT, statePath: join(dir, 's.json') })
    const journal = startSessionLogJournal(port, { generation: 0 })!
    await service.lifecycle.restart()
    expect(journal.disabled).toBeNull()
    expect(await journal.flush()).toBe(true) // a restart did not stop it
    writeStore(dbPath, after)
    await service.lifecycle.stop()
    // The restart neither flushed nor stopped the journal (no batch yet at its
    // stop); the host stop wrote the second batch (the revert) before OpenCode stopped.
    expect(calls).toEqual(['stop:0', 'restart', 'stop:2'])
    expect(await journal.flush()).toBe(false) // stopped
    expect(dumped()[1]!.tombstones).toHaveLength(2)
  })
})
