/**
 * Read-only reader for `opencode.db`.
 *
 * The fixture is the live 1.18.23 schema (WS-V §2.2), including the two indexes
 * that make the transcript read a B-tree range scan, and the `event` /
 * `event_sequence` pair OpenCode writes its durable log into.
 *
 * The tests that matter are the unhappy ones: a missing file, a schema that
 * does not match, a writer holding the database, and a row whose JSON is
 * garbage. Each must degrade to "the caller falls back", never to a wrong
 * transcript.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OpencodeDb, isSupportedOpencodeVersion } from '../opencode-db'

let root: string
let dbPath: string

function schema(db: Database): void {
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
      version text NOT NULL, revert text, permission text, agent text, model text,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE event (
      id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
      type text NOT NULL, data text NOT NULL
    );
    CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq);
  `)
}

function seedSession(db: Database, id: string, title = 'New session', updated = 100): void {
  db.query(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'prj_1', ?, '/workspace', ?, '1.18.23', 1, ?)`,
  ).run(id, id, title, updated)
}

function seedMessage(db: Database, session: string, n: number, role = 'assistant'): string {
  const id = `msg_${session}_${String(n).padStart(3, '0')}`
  db.query('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    id,
    session,
    n * 10,
    n * 10,
    JSON.stringify({ id, sessionID: session, role, time: { created: n * 10 } }),
  )
  db.query('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    `prt_${id}_a`,
    id,
    session,
    n * 10,
    n * 10,
    JSON.stringify({ id: `prt_${id}_a`, messageID: id, sessionID: session, type: 'text', text: `body ${n}` }),
  )
  return id
}

function seedEvent(db: Database, aggregate: string, seq: number, type: string, data: unknown): void {
  db.query('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(
    `evt_${aggregate}_${seq}`,
    aggregate,
    seq,
    type,
    JSON.stringify(data),
  )
  db.query(
    'INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq',
  ).run(aggregate, seq)
}

function build(seed: (db: Database) => void): void {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  schema(db)
  seed(db)
  db.close()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-ocdb-'))
  dbPath = join(root, 'opencode.db')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('version gate', () => {
  test('only the verified minor lines pass', () => {
    expect(isSupportedOpencodeVersion('1.18.23')).toBe(true)
    expect(isSupportedOpencodeVersion('1.18.0')).toBe(true)
    expect(isSupportedOpencodeVersion('1.19.0')).toBe(false)
    expect(isSupportedOpencodeVersion('2.0.1')).toBe(false)
    expect(isSupportedOpencodeVersion(null)).toBe(false)
    expect(isSupportedOpencodeVersion('nonsense')).toBe(false)
  })
})

describe('probe', () => {
  test('a live-shaped database is supported', () => {
    build(() => {})
    const probe = new OpencodeDb(dbPath).probe()
    expect(probe).toMatchObject({ supported: true, reason: null })
  })

  test('a missing file is unsupported, not a throw', () => {
    const probe = new OpencodeDb(join(root, 'nope.db')).probe()
    expect(probe.supported).toBe(false)
    expect(probe.reason).toBeTruthy()
  })

  test('a database missing the event log is unsupported', () => {
    const db = new Database(dbPath, { create: true })
    db.exec(`
      CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL, directory text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `)
    db.close()
    const probe = new OpencodeDb(dbPath).probe()
    expect(probe).toMatchObject({ supported: false, reason: 'missing table event' })
  })

  test('a renamed column is unsupported — the shape gate, not just the table gate', () => {
    build(() => {})
    const writer = new Database(dbPath)
    writer.exec('ALTER TABLE part RENAME COLUMN data TO payload')
    writer.close()
    const probe = new OpencodeDb(dbPath).probe()
    expect(probe).toMatchObject({ supported: false, reason: 'missing part.data' })
  })
})

describe('reads', () => {
  test('sessions come back newest-updated first', () => {
    build((db) => {
      seedSession(db, 'ses_old', 'older', 10)
      seedSession(db, 'ses_new', 'newer', 90)
    })
    const rows = new OpencodeDb(dbPath).sessions()!
    expect(rows.map((r) => r.id)).toEqual(['ses_new', 'ses_old'])
  })

  test('the newest page is returned oldest-first, with has_more', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 10; i++) seedMessage(db, 'ses_a', i)
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 3 })!
    expect(page.messages.map((m) => m.info.id)).toEqual([
      'msg_ses_a_008',
      'msg_ses_a_009',
      'msg_ses_a_010',
    ])
    expect(page.hasMore).toBe(true)
    expect(page.messages[0]!.parts[0]!.text).toBe('body 8')
  })

  test('`before` walks backwards for loadOlder', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 10; i++) seedMessage(db, 'ses_a', i)
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 2, before: 'msg_ses_a_008' })!
    expect(page.messages.map((m) => m.info.id)).toEqual(['msg_ses_a_006', 'msg_ses_a_007'])
    expect(page.hasMore).toBe(true)
  })

  test('`after` walks forwards and reports the end of the transcript', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 5; i++) seedMessage(db, 'ses_a', i)
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 10, after: 'msg_ses_a_003' })!
    expect(page.messages.map((m) => m.info.id)).toEqual(['msg_ses_a_004', 'msg_ses_a_005'])
    expect(page.hasMore).toBe(false)
  })

  test('`after_seq` returns exactly the messages the durable log says changed', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 5; i++) seedMessage(db, 'ses_a', i)
      seedEvent(db, 'ses_a', 1, 'message.updated.1', { info: { id: 'msg_ses_a_001' } })
      seedEvent(db, 'ses_a', 2, 'session.updated.1', { info: { id: 'ses_a' } })
      seedEvent(db, 'ses_a', 3, 'message.part.updated.1', { part: { messageID: 'msg_ses_a_004' } })
      seedEvent(db, 'ses_a', 4, 'message.updated.1', { info: { id: 'msg_ses_a_005' } })
    })
    const db = new OpencodeDb(dbPath)
    expect(db.headSeq('ses_a')).toBe(4)
    const page = db.messagePage({ sessionId: 'ses_a', limit: 50, afterSeq: 2 })!
    expect(page.messages.map((m) => m.info.id)).toEqual(['msg_ses_a_004', 'msg_ses_a_005'])
    // Nothing changed after the head: an empty delta, not a full page.
    expect(db.messagePage({ sessionId: 'ses_a', limit: 50, afterSeq: 4 })!.messages).toEqual([])
  })

  test('headSeqs reports every aggregate — a subagent has its own counter', () => {
    build((db) => {
      seedSession(db, 'ses_root')
      seedSession(db, 'ses_child')
      seedEvent(db, 'ses_root', 42, 'message.updated.1', {})
      seedEvent(db, 'ses_child', 7, 'message.updated.1', {})
    })
    expect(new OpencodeDb(dbPath).headSeqs()).toEqual({ ses_root: 42, ses_child: 7 })
  })

  test('an unknown cursor yields an empty page, never the whole transcript', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 5; i++) seedMessage(db, 'ses_a', i)
    })
    const db = new OpencodeDb(dbPath)
    expect(db.messagePage({ sessionId: 'ses_a', limit: 50, after: 'msg_nope' })!.messages).toEqual([])
    expect(db.messagePage({ sessionId: 'ses_a', limit: 50, before: 'msg_nope' })!.messages).toEqual([])
  })

  test('an unparseable message is DROPPED whole and counted, never half-served', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      seedMessage(db, 'ses_a', 1)
      db.query('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
        'msg_broken',
        'ses_a',
        20,
        20,
        '{not json',
      )
      seedMessage(db, 'ses_a', 3)
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 50 })!
    expect(page.messages.map((m) => m.info.id)).toEqual(['msg_ses_a_001', 'msg_ses_a_003'])
    expect(page.dropped).toBe(1)
  })

  test('an unparseable PART is dropped without losing its message', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      seedMessage(db, 'ses_a', 1)
      db.query('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(
        'prt_broken',
        'msg_ses_a_001',
        'ses_a',
        11,
        11,
        'nope',
      )
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 50 })!
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]!.parts.map((p) => p.id)).toEqual(['prt_msg_ses_a_001_a'])
    expect(page.dropped).toBe(1)
  })

  test('reads are refused, not silently degraded, when the file is gone', () => {
    const db = new OpencodeDb(join(root, 'absent.db'))
    expect(db.messagePage({ sessionId: 'ses_a', limit: 10 })).toBeNull()
    expect(db.sessions()).toBeNull()
    expect(db.headSeqs()).toBeNull()
  })
})

describe('concurrency with a live writer', () => {
  test('a page taken mid-write sees ONE consistent snapshot, never a mix', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      for (let i = 1; i <= 5; i++) seedMessage(db, 'ses_a', i)
    })
    const reader = new OpencodeDb(dbPath)
    // Warm the connection so the read below is the only thing under test.
    expect(reader.messagePage({ sessionId: 'ses_a', limit: 50 })!.messages).toHaveLength(5)

    const writer = new Database(dbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    // A writer holding an open transaction: WAL means the reader still sees the
    // last committed snapshot rather than blocking or reading the pending write.
    writer.exec('BEGIN IMMEDIATE')
    writer
      .query('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
      .run('msg_pending', 'ses_a', 999, 999, JSON.stringify({ id: 'msg_pending', role: 'user' }))

    const page = reader.messagePage({ sessionId: 'ses_a', limit: 50 })!
    expect(page.messages.map((m) => m.info.id)).not.toContain('msg_pending')
    expect(page.messages).toHaveLength(5)

    writer.exec('COMMIT')
    // …and the very next read sees it. No cache, no restart — the same
    // behaviour attachment-offload.ts verified live on box i67m4.
    expect(reader.messagePage({ sessionId: 'ses_a', limit: 50 })!.messages).toHaveLength(6)
    writer.close()
    reader.close()
  })

  test('a write from this reader is refused — query_only, not just the open flag', () => {
    build((db) => seedSession(db, 'ses_a'))
    const reader = new OpencodeDb(dbPath)
    reader.sessions()
    // Reach through the private field the way a careless future edit would.
    const raw = (reader as unknown as { db: Database }).db
    expect(() => raw.exec("UPDATE session SET title = 'hacked'")).toThrow()
    reader.close()
  })
})
