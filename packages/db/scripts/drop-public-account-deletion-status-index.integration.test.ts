/**
 * The unused-index drop on the legacy `public.account_deletion_requests`, against a
 * real PostgreSQL.
 *
 * The Supabase advisor `unused_index` lint flagged `idx_account_deletion_requests_status`
 * on that table (KRTX-1218). The table is a pre-baseline legacy copy — the managed
 * surface models `account_deletion_requests` in the `kortix` schema — so a fresh
 * database never has it and the migration must also be a clean no-op there. The lane
 * hands this file a fresh migrated database; the setup rebuilds the production legacy
 * shape on it first (table, its six indexes, both RLS policies), so the drop can
 * never pass vacuously. Nothing here can be asserted without a server: the objects
 * live in `pg_indexes` / `pg_policies`.
 *
 * The migration is a `.concurrent.ts` escape hatch: its statements run outside any
 * transaction, so the test executes the file's own `pgm.sql()` statements one by one
 * on a single autocommit session — never wrapped in BEGIN/COMMIT.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const MIGRATION_FILE = '20261003061617698_drop_public_account_deletion_status_index.concurrent.ts';
const DROPPED_INDEX = 'idx_account_deletion_requests_status';
/** The legacy table's other indexes; the drop must leave every one of them. */
const KEPT_INDEXES = [
  'account_deletion_requests_pkey',
  'idx_account_deletion_requests_account_id',
  'idx_account_deletion_requests_scheduled',
  'idx_account_deletion_requests_user_id',
  'unique_active_deletion_request',
];
const POLICIES = [
  'Service role can manage deletion requests',
  'Users can view their own deletion requests',
];

/** The migration's statements, read from the file so it always runs what ships. */
async function migrationStatements(): Promise<string[]> {
  const source = await Bun.file(
    resolve(import.meta.dir, '..', 'migrations', MIGRATION_FILE),
  ).text();
  const statements: string[] = [];
  for (const match of source.matchAll(/pgm\.sql\(`([^`]+)`\)/g)) {
    if (match[1]) statements.push(match[1]);
  }
  if (statements.length !== 3) {
    throw new Error(
      `expected 3 pgm.sql() statements in ${MIGRATION_FILE}, found ${statements.length}`,
    );
  }
  return statements;
}

/** The legacy shape prod still carries: six indexes, both wrapped RLS policies. */
async function legacyFixture(client: pg.Client): Promise<void> {
  await client.query(`
    create table public.account_deletion_requests (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null,
      user_id uuid not null,
      requested_at timestamptz not null default now(),
      deletion_scheduled_for timestamptz not null,
      reason text,
      is_cancelled boolean default false,
      cancelled_at timestamptz,
      is_deleted boolean default false,
      deleted_at timestamptz,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create index idx_account_deletion_requests_account_id
      on public.account_deletion_requests using btree (account_id);
    create index idx_account_deletion_requests_scheduled
      on public.account_deletion_requests using btree (deletion_scheduled_for)
      where ((is_cancelled = false) and (is_deleted = false));
    create index idx_account_deletion_requests_status
      on public.account_deletion_requests using btree (is_cancelled, is_deleted);
    create index idx_account_deletion_requests_user_id
      on public.account_deletion_requests using btree (user_id);
    create unique index unique_active_deletion_request
      on public.account_deletion_requests using btree (account_id)
      where ((is_cancelled = false) and (is_deleted = false));
    alter table public.account_deletion_requests enable row level security;
    create policy "Service role can manage deletion requests"
      on public.account_deletion_requests using ((select auth.role()) = 'service_role'::text);
    create policy "Users can view their own deletion requests"
      on public.account_deletion_requests for select using ((select auth.uid()) = user_id);
    -- synthetic rows only
    insert into public.account_deletion_requests (account_id, user_id, deletion_scheduled_for)
    select gen_random_uuid(), gen_random_uuid(), now() + interval '3 days'
      from generate_series(1, 3);
  `);
}

async function tableIndexes(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'account_deletion_requests'
      order by indexname`,
  );
  return rows.map((row) => row.indexname);
}

suite('drop public account_deletion_requests status index — real PostgreSQL', () => {
  let client: pg.Client;
  let statements: string[];

  beforeAll(async () => {
    if (!databaseUrl) return;
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    statements = await migrationStatements();
    await legacyFixture(client);
    // Pre-state: the fixture presents the production shape, dropped index included,
    // so a pass below can never be vacuous.
    expect(await tableIndexes(client)).toEqual([...KEPT_INDEXES, DROPPED_INDEX].sort());
  });

  afterAll(async () => {
    if (!client) return;
    await client
      .query('drop table if exists public.account_deletion_requests')
      .catch(() => undefined);
    await client.end();
  });

  test('drops the unused index and keeps its neighbors, policies and rows', async () => {
    for (const statement of statements) {
      await client.query(statement);
    }

    expect(await tableIndexes(client)).toEqual(KEPT_INDEXES.sort());

    const { rows: policies } = await client.query<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = 'account_deletion_requests'
        order by policyname`,
    );
    expect(policies.map((row) => row.policyname)).toEqual(POLICIES.sort());

    const { rows: rls } = await client.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'account_deletion_requests'`,
    );
    expect(rls).toHaveLength(1);
    expect(rls[0]?.relrowsecurity).toBe(true);

    const { rows: counts } = await client.query<{ count: string }>(
      'select count(*) from public.account_deletion_requests',
    );
    expect(counts[0]?.count).toBe('3');
  });

  test('a second apply is a no-op (IF EXISTS)', async () => {
    for (const statement of statements) {
      await client.query(statement);
    }
    expect(await tableIndexes(client)).toEqual(KEPT_INDEXES.sort());
  });

  test('is a no-op on a database that never had the legacy table', async () => {
    await client.query('drop table if exists public.account_deletion_requests');
    for (const statement of statements) {
      await client.query(statement);
    }
    expect(await tableIndexes(client)).toEqual([]);
  });
});
