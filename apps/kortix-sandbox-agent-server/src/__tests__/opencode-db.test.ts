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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OpencodeDb,
  SQLITE_READER_SUPPORTED_MINORS,
  isSupportedOpencodeVersion,
} from '../harness/open-code/opencode-db'

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

  // SQLITE_READER_SUPPORTED_MINORS is a COPY of a fact in
  // packages/shared/src/runtime-versions.json: the daemon ships inside the
  // sandbox image and cannot import the monorepo. When the OpenCode pin moves to
  // a minor line this reader has not been verified against, this fails here
  // instead of serving a transcript from a schema nobody checked. Fixing it is
  // deliberate work: verify the shape on a box of the new version, then add the
  // minor line.
  test('the shipped OpenCode pin is a version this reader is verified against', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../../packages/shared/src/runtime-versions.json'), 'utf8'),
    ) as { opencode?: string }
    expect(typeof manifest.opencode).toBe('string')
    expect(
      isSupportedOpencodeVersion(manifest.opencode!),
      `runtime-versions.json pins opencode ${manifest.opencode}, outside ` +
        `SQLITE_READER_SUPPORTED_MINORS (${SQLITE_READER_SUPPORTED_MINORS.join(', ')}).`,
    ).toBe(true)
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
  test('hydrates message and part identities from SQLite columns when data omits them', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      seedMessage(db, 'ses_a', 1, 'user')
      db.query('UPDATE message SET data = ? WHERE id = ?').run(
        JSON.stringify({ role: 'user', time: { created: 10 } }),
        'msg_ses_a_001',
      )
      db.query('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({ type: 'text', text: 'body 1' }),
        'prt_msg_ses_a_001_a',
      )
    })
    const page = new OpencodeDb(dbPath).messagePage({ sessionId: 'ses_a', limit: 10 })!
    expect(page.messages[0]!.info).toMatchObject({ id: 'msg_ses_a_001', sessionID: 'ses_a' })
    expect(page.messages[0]!.parts[0]).toMatchObject({
      id: 'prt_msg_ses_a_001_a', messageID: 'msg_ses_a_001', sessionID: 'ses_a',
    })
  })

  test('sessions come back newest-updated first', () => {
    build((db) => {
      seedSession(db, 'ses_old', 'older', 10)
      seedSession(db, 'ses_new', 'newer', 90)
    })
    const rows = new OpencodeDb(dbPath).sessions()!
    expect(rows.map((r) => r.id)).toEqual(['ses_new', 'ses_old'])
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

describe('openTurnMessageId — the turn that is RUNNING, from one small row', () => {
  // The memory guard asks this at 97 % box memory, so it must not load parts
  // (that is where inline image bytes live) and must not go through HTTP.
  function seedTurn(
    db: Database,
    session: string,
    n: number,
    role: 'user' | 'assistant',
    opts: { parent?: string; completed?: boolean; error?: { name: string; data?: { isRetryable?: boolean } } } = {},
  ): string {
    const id = seedMessage(db, session, n, role)
    db.query('UPDATE message SET data = ? WHERE id = ?').run(
      JSON.stringify({
        role,
        ...(opts.parent ? { parentID: opts.parent } : {}),
        ...(opts.error ? { error: opts.error } : {}),
        time: { created: n * 10, ...(opts.completed ? { completed: n * 10 + 5 } : {}) },
      }),
      id,
    )
    return id
  }

  test('names the user message the OPEN newest assistant message answers', () => {
    let running = ''
    build((db) => {
      seedSession(db, 'ses_a')
      const first = seedTurn(db, 'ses_a', 1, 'user')
      seedTurn(db, 'ses_a', 2, 'assistant', { parent: first, completed: true })
      running = seedTurn(db, 'ses_a', 3, 'user')
      seedTurn(db, 'ses_a', 4, 'assistant', { parent: running })
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBe(running)
  })

  test('a prompt forwarded into the live turn does not hide the turn that is running', () => {
    let running = ''
    build((db) => {
      seedSession(db, 'ses_a')
      running = seedTurn(db, 'ses_a', 1, 'user')
      seedTurn(db, 'ses_a', 2, 'assistant', { parent: running })
      seedTurn(db, 'ses_a', 3, 'user')
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBe(running)
  })

  test('a FINISHED turn is never named: blaming it for a later abort would rewrite its history', () => {
    // The guard also fires when it cannot tell whether a turn is running. The
    // newest assistant row then belongs to a turn that already ended.
    build((db) => {
      seedSession(db, 'ses_a')
      const done = seedTurn(db, 'ses_a', 1, 'user')
      seedTurn(db, 'ses_a', 2, 'assistant', { parent: done, completed: true })
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBeNull()
  })

  test('a turn that already ended in an error is not running either', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      const dead = seedTurn(db, 'ses_a', 1, 'user')
      seedTurn(db, 'ses_a', 2, 'assistant', { parent: dead, error: { name: 'MessageAbortedError' } })
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBeNull()
  })

  test('a retrying turn is still running', () => {
    let running = ''
    build((db) => {
      seedSession(db, 'ses_a')
      running = seedTurn(db, 'ses_a', 1, 'user')
      seedTurn(db, 'ses_a', 2, 'assistant', {
        parent: running,
        error: { name: 'APIError', data: { isRetryable: true } },
      })
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBe(running)
  })

  test('is scoped to the session, and null when no assistant message exists', () => {
    build((db) => {
      seedSession(db, 'ses_a')
      seedSession(db, 'ses_b')
      const other = seedTurn(db, 'ses_b', 1, 'user')
      seedTurn(db, 'ses_b', 2, 'assistant', { parent: other })
      seedTurn(db, 'ses_a', 3, 'user')
    })
    expect(new OpencodeDb(dbPath).openTurnMessageId('ses_a')).toBeNull()
  })
})
