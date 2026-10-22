/**
 * Integration test (real PostgreSQL, fresh migrated database): the
 * `kortix.session/2` storage tables exist with the shape the session log
 * writers (P2.2 ingest, P2.7 dual-write, P3 backfill) and the P4.2 read rely on.
 *
 * Raw SQL on purpose: this proves the MIGRATED CATALOG, independent of the
 * drizzle declarations (`schema-contract.ts` proves those match it).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sessionLogMessages } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = `ses-log-${crypto.randomUUID().slice(0, 8)}`;
const TABLES = ['session_logs', 'session_log_threads', 'session_log_messages', 'session_log_blobs'] as const;

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Row[];

const record = (seq: number, id: string) =>
  JSON.stringify({ schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'main', seq, blocks: [] });

// A daemon journal revision: max(Date.now() * 1000, last + 1), past int4.
const REV = 1_791_681_474_704_000;

const insertMessage = (id: string, seq: number) =>
  db.execute(sql`
    INSERT INTO kortix.session_log_messages
      (session_id, message_id, thread_id, seq, role, kind, in_context, created_at, v,
       producer, generation, rev, content_hash, record)
    VALUES (${SESSION}, ${id}, 'main', ${seq}, 'user', 'turn', true, now(), 1,
            ${JSON.stringify({ harness: 'opencode', harness_version: '1.0.0', adapter_version: '1' })}::jsonb,
            0, ${REV + seq}, ${`sha256-${id}`}, ${record(seq, id)}::jsonb)`);

const count = async (table: (typeof TABLES)[number]) => {
  const [row] = await rows(sql`SELECT count(*)::int AS n FROM ${sql.raw(`kortix.${table}`)} WHERE session_id = ${SESSION}`);
  return row!.n as number;
};

beforeAll(async () => {
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT}, 'session-log-tables-test')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT}, ${ACCOUNT}, 'p', 'https://example.com/p.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name)
    VALUES (${SESSION}, ${ACCOUNT}, ${PROJECT}, ${SESSION})`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.projects WHERE account_id = ${ACCOUNT}`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT}`);
});

test('a session stores one log row, a thread, two messages and a blob', async () => {
  await db.execute(sql`
    INSERT INTO kortix.session_logs
      (session_id, project_id, account_id, v, harness_current, restore_grade, record)
    VALUES (${SESSION}, ${PROJECT}, ${ACCOUNT}, 1, 'opencode', 'native',
            ${JSON.stringify({ schema: 'kortix.session/2', v: 1, session_id: SESSION })}::jsonb)`);
  await db.execute(sql`
    INSERT INTO kortix.session_log_threads (session_id, thread_id, parent_thread_id, v, record)
    VALUES (${SESSION}, 'main', NULL, 1, ${JSON.stringify({ thread_id: 'main' })}::jsonb)`);
  await insertMessage('msg_a', 1);
  await insertMessage('msg_b', 2);
  await db.execute(sql`
    INSERT INTO kortix.session_log_blobs (session_id, sha256, object_key, bytes, mime)
    VALUES (${SESSION}, ${'0'.repeat(64)}, ${`session-log/${SESSION}/blob`}, 5000000000, 'image/png')`);

  const [log] = await rows(sql`SELECT generation, grade_counts FROM kortix.session_logs WHERE session_id = ${SESSION}`);
  expect(log).toEqual({ generation: 0, grade_counts: null });
  const page = await rows(sql`
    SELECT message_id, seq, rev::text AS rev, deleted_at FROM kortix.session_log_messages
     WHERE session_id = ${SESSION} AND thread_id = 'main' ORDER BY seq DESC`);
  expect(page).toEqual([
    { message_id: 'msg_b', seq: 2, rev: String(REV + 2), deleted_at: null },
    { message_id: 'msg_a', seq: 1, rev: String(REV + 1), deleted_at: null },
  ]);
  // bigint: a blob over 2^31 bytes round-trips.
  const [blob] = await rows(sql`SELECT bytes::text AS bytes FROM kortix.session_log_blobs WHERE session_id = ${SESSION}`);
  expect(blob!.bytes).toBe('5000000000');
});

test('rev read through the drizzle column is an exact JS number past int4', async () => {
  // Raw `db.execute` returns int8 as a string (postgres.js); the drizzle
  // column (`bigint`, mode 'number') maps it with Number.
  const [row] = await db
    .select({ rev: sessionLogMessages.rev })
    .from(sessionLogMessages)
    .where(and(eq(sessionLogMessages.sessionId, SESSION), eq(sessionLogMessages.messageId, 'msg_b')));
  expect(typeof row!.rev).toBe('number');
  expect(row!.rev).toBe(REV + 2);
});

test('the four tables carry exactly the declared indexes and constraints', async () => {
  const indexes = await rows(sql`
    SELECT i.indexrelid::regclass::text AS index
      FROM pg_index i
     WHERE i.indrelid IN ('kortix.session_logs'::regclass, 'kortix.session_log_threads'::regclass,
                          'kortix.session_log_messages'::regclass, 'kortix.session_log_blobs'::regclass)
     ORDER BY 1`);
  expect(indexes.map((row) => row.index)).toEqual([
    'kortix.session_log_blobs_pkey',
    'kortix.session_log_messages_pkey',
    'kortix.session_log_messages_thread_seq_key',
    'kortix.session_log_threads_pkey',
    'kortix.session_logs_pkey',
  ]);
  const constraints = await rows(sql`
    SELECT conrelid::regclass::text AS on_table, conname AS name, contype::text AS type,
           condeferrable AS deferrable, confrelid::regclass::text AS refs, confdeltype::text AS on_delete
      FROM pg_constraint
     WHERE conrelid IN ('kortix.session_logs'::regclass, 'kortix.session_log_threads'::regclass,
                        'kortix.session_log_messages'::regclass, 'kortix.session_log_blobs'::regclass)
     ORDER BY 2`);
  const pk = (on_table: string, name: string) => ({ on_table, name, type: 'p', deferrable: false, refs: '-', on_delete: ' ' });
  // confdeltype 'c' = ON DELETE CASCADE.
  const fk = (on_table: string, name: string) =>
    ({ on_table, name, type: 'f', deferrable: false, refs: 'kortix.project_sessions', on_delete: 'c' });
  expect(constraints).toEqual([
    pk('kortix.session_log_blobs', 'session_log_blobs_pkey'),
    fk('kortix.session_log_blobs', 'session_log_blobs_session_fk'),
    pk('kortix.session_log_messages', 'session_log_messages_pkey'),
    fk('kortix.session_log_messages', 'session_log_messages_session_fk'),
    { on_table: 'kortix.session_log_messages', name: 'session_log_messages_thread_seq_key', type: 'u', deferrable: false, refs: '-', on_delete: ' ' },
    pk('kortix.session_log_threads', 'session_log_threads_pkey'),
    fk('kortix.session_log_threads', 'session_log_threads_session_fk'),
    pk('kortix.session_logs', 'session_logs_pkey'),
    fk('kortix.session_logs', 'session_logs_session_fk'),
  ]);
});

test('a second message at the same (session_id, thread_id, seq) is rejected', async () => {
  const failure = await insertMessage('msg_c', 2).then(
    () => null,
    (error: unknown) => error as { cause?: { code?: string; constraint_name?: string } },
  );
  expect(failure?.cause?.code).toBe('23505');
  expect(failure?.cause?.constraint_name).toBe('session_log_messages_thread_seq_key');
});

test('session_turns.log_durable_at is nullable and writable', async () => {
  const token = `turn-${crypto.randomUUID()}`;
  await db.execute(sql`
    INSERT INTO kortix.session_turns (turn_token, session_id, sandbox_id, project_id, account_id)
    VALUES (${token}, ${SESSION}, ${crypto.randomUUID()}, ${PROJECT}, ${ACCOUNT})`);
  const [before] = await rows(sql`SELECT log_durable_at FROM kortix.session_turns WHERE turn_token = ${token}`);
  expect(before!.log_durable_at).toBeNull();
  await db.execute(sql`UPDATE kortix.session_turns SET log_durable_at = now() WHERE turn_token = ${token}`);
  const [after] = await rows(sql`SELECT log_durable_at IS NOT NULL AS set FROM kortix.session_turns WHERE turn_token = ${token}`);
  expect(after!.set).toBe(true);
  await db.execute(sql`DELETE FROM kortix.session_turns WHERE turn_token = ${token}`);
});

test('only the service role reads the tables: RLS on, no policy, no anon/authenticated privilege', async () => {
  for (const table of TABLES) {
    const qualified = `kortix.${table}`;
    const [state] = await rows(sql`
      SELECT c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'kortix' AND p.tablename = ${table}) AS policies,
             has_table_privilege('anon', ${qualified}, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
             has_table_privilege('authenticated', ${qualified}, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kortix' AND c.relname = ${table}`);
    expect({ table, ...state } as Row).toEqual({ table, rls: true, policies: 0, anon: false, authenticated: false });
  }
});

test('deleting the session row cascades every session_log table to zero rows', async () => {
  for (const table of TABLES) expect(await count(table)).toBeGreaterThan(0);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION}`);
  for (const table of TABLES) expect({ table, n: await count(table) }).toEqual({ table, n: 0 });
});
