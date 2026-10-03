import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const client = new pg.Client({ connectionString: databaseUrl });

beforeAll(async () => {
  await client.connect();
  // The suite owns its migration ledger, so a reused database starts clean
  // (the db-suites lane gives every file a fresh one; local runs may not).
  await client.query('DROP SCHEMA IF EXISTS messages_index_test_migrations CASCADE');
  await client.query('DROP TABLE IF EXISTS public.messages');
  // The DB-suite runner provides an isolated database. Legacy messages is not
  // created by the Kortix baseline; build its relevant shape with synthetic data.
  await client.query(`CREATE TABLE public.messages (
    thread_id uuid NOT NULL, type text NOT NULL, created_at timestamptz NOT NULL
  )`);
  await client.query(`CREATE INDEX idx_messages_thread_type_created
    ON public.messages (thread_id, type, created_at DESC)`);
  await client.query(`CREATE INDEX idx_messages_thread_type_created_desc
    ON public.messages (thread_id, type, created_at DESC)`);
  await client.query(`INSERT INTO public.messages VALUES
    ('00000000-0000-0000-0000-000000000001', 'assistant', '2026-01-01'),
    ('00000000-0000-0000-0000-000000000001', 'assistant', '2026-01-02')`);
});

afterAll(async () => {
  await client.query('DROP TABLE IF EXISTS public.messages');
  await client.end();
});

async function migrate() {
  await runner({
    databaseUrl,
    dir: join(import.meta.dir, '..', 'migrations'),
    migrationsSchema: 'messages_index_test_migrations',
    createMigrationsSchema: true,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    count: Infinity,
    singleTransaction: true,
    checkOrder: false,
    ignorePattern: '^(?!.*_drop_messages_duplicate_index\\.concurrent\\.ts$).*',
    log: () => {},
  });
}

test('drops only the redundant index and preserves the valid descending index and reads', async () => {
  await migrate();
  const { rows } = await client.query(`SELECT c.relname, i.indisvalid, i.indisunique,
    (i.indoption[2] & 1) = 1 AS descending
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.messages'::regclass`);
  expect(rows).toEqual([{
    relname: 'idx_messages_thread_type_created_desc',
    indisvalid: true,
    indisunique: false,
    descending: true,
  }]);
  const result = await client.query(`SELECT created_at::text FROM public.messages
    WHERE thread_id = '00000000-0000-0000-0000-000000000001'
      AND type = 'assistant' ORDER BY created_at DESC`);
  expect(result.rows.map((row) => row.created_at)).toEqual([
    '2026-01-02 00:00:00+00', '2026-01-01 00:00:00+00',
  ]);
});

test('can execute again when the redundant index is already absent', async () => {
  await client.query('TRUNCATE messages_index_test_migrations.pgmigrations');
  await migrate();
  const { rows } = await client.query(`SELECT to_regclass(
    'public.idx_messages_thread_type_created_desc') IS NOT NULL AS retained`);
  expect(rows[0].retained).toBe(true);
  const dropped = await client.query(`SELECT to_regclass(
    'public.idx_messages_thread_type_created') IS NULL AS absent`);
  expect(dropped.rows[0].absent).toBe(true);
});

test('is a no-op on a fresh database without the legacy messages table', async () => {
  await client.query('DROP TABLE public.messages');
  await client.query('TRUNCATE messages_index_test_migrations.pgmigrations');
  await migrate();
  const { rows } = await client.query(`SELECT to_regclass('public.messages') IS NULL AS absent`);
  expect(rows[0].absent).toBe(true);
});
