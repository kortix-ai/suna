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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AdapterCapabilitiesSchema,
  fromV1,
  SessionLogJournalRequestSchema,
  upcast,
  type ExportCursor,
  type SessionLog,
  type SessionLogMessage,
  type V1Row,
} from '@kortix/api-contract/session-log'
import { createOpenCodeSessionLogPort, OPENCODE_CAPABILITIES, openCodeSessionLog, startOpenCodeSessionLog, type SeqState } from '@/harness/open-code/session-log'
import { OpencodeDb, type StoreSnapshot } from '@/harness/open-code/opencode-db'
import { composeOpenCodeHarnessService } from '@/harness/open-code/service'
import { readOpenCodeSessionPin, writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { flushSessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'
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
    expect(await noStore.restore({} as SessionLog)).toEqual([])
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
    // The port `startOpenCodeSessionLog` builds, on a test path: the production
    // one reads OpenCode's home (`homedir()`), which a test cannot redirect.
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

  test('without a control plane the boot start journals nothing', () => {
    delete process.env.KORTIX_SESSION_ID
    startOpenCodeSessionLog()
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
