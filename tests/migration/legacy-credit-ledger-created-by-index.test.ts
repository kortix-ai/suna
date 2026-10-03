// KRTX-1122: the legacy public.credit_ledger — the pre-baseline wallet table
// that still exists on environments which predate 20260621094136410_baseline.sql
// — carries FK credit_ledger_created_by_fkey (created_by -> auth.users(id))
// with no covering index. The Supabase advisor lints it as
// unindexed_foreign_keys, and every auth.users deletion pays a full scan of
// ~4.3M rows to enforce the FK (NO ACTION).
//
// 20261002213944816_legacy_credit_ledger_created_by_index.concurrent.ts builds
// the missing index CONCURRENTLY where the legacy table exists and must be a
// no-op on fresh databases, which never get public.credit_ledger (the baseline
// builds only the kortix schema; an unguarded CREATE INDEX would fail every
// fresh install and every db suite).
//
// Both paths run for real here, in two databases of one throwaway Postgres:
//
//   legacy — public.credit_ledger seeded (prod's exact column order, FK
//            included) BEFORE runMigrate; the migration must build a VALID
//            covering index.
//   fresh  — pristine database; the migration must run as a no-op and still
//            record itself in the ledger.
//
// The covered/uncovered assertion is the Supabase advisor's own predicate: an
// index whose leading key columns contain the FK's conkey columns.
//
//   bun test tests/migration/legacy-credit-ledger-created-by-index.test.ts   (needs docker)
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Ports,
  computePorts,
  repoRoot,
  run,
  runMigrate,
  sh,
} from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-legacy-ledger-index-test';
// Below 32768 for the reason given in worktree-migrate.test.ts.
const PORT = Number(process.env.LEGACY_CREDIT_LEDGER_INDEX_TEST_PORT || 5447);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const FRESH_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/fresh`;
const MIGRATION_NAME = '20261002213944816_legacy_credit_ledger_created_by_index.concurrent';

function psqlOn(url: string, query: string): string {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tAc', query]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${query}`);
  return res.stdout.trim();
}

const psql = (query: string): string => psqlOn(URL, query);

function pgReady(): boolean {
  return sh(['psql', URL, '-tAc', 'select 1']).ok;
}

/**
 * The Supabase advisor's own predicate (unindexed_foreign_keys): the FK is
 * flagged unless an index on the referencing table holds the FK's conkey
 * columns as its leading key columns. `indisvalid` is checked too — a
 * cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index that the
 * advisor would still count and that Postgres would not use.
 */
function fkCovered(url: string): boolean {
  return (
    psqlOn(url, `
      select exists (
        select 1
          from pg_constraint con
          join pg_index i on i.indrelid = con.conrelid
         where con.conname = 'credit_ledger_created_by_fkey'
           and con.conrelid = 'public.credit_ledger'::regclass
           and (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] @> con.conkey
           and i.indisvalid
      )
    `) === 't'
  );
}

// The legacy table in prod's exact column order, so created_by is attnum 11
// there as well (the advisor output that filed KRTX-1122 points at column 11).
const LEGACY_TABLE_SQL = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create table public.credit_ledger (
    id uuid primary key,
    account_id uuid not null,
    amount numeric(12,4) default 0 not null,
    balance_after numeric(12,4) default 0 not null,
    type text not null,
    description text,
    reference_id uuid,
    reference_type text,
    metadata jsonb default '{}',
    created_at timestamptz default now(),
    created_by uuid,
    is_expiring boolean default true,
    expires_at timestamptz,
    stripe_event_id varchar(255),
    message_id uuid,
    thread_id uuid,
    processing_source text,
    idempotency_key text,
    locked_at timestamptz
  );
  alter table public.credit_ledger
    add constraint credit_ledger_created_by_fkey
    foreign key (created_by) references auth.users(id);
  insert into auth.users (id) values (gen_random_uuid());
  insert into public.credit_ledger (account_id, type, created_by)
    values (gen_random_uuid(), 'usage', (select id from auth.users limit 1));
`;

async function migrateDatabase(url: string): Promise<void> {
  // The two steps scripts/worktree/lib/migrate.ts runMigrate() performs, aimed
  // at an arbitrary database: platform prereqs, then the loopback-only migrate.
  const prereqs = join(ROOT, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  const pre = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
  if (!pre.ok) throw new Error(`prereqs failed: ${pre.stderr}`);
  const code = await run(['pnpm', '--filter', '@kortix/db', 'migrate:local'], {
    cwd: ROOT,
    env: { DATABASE_URL: url },
  });
  if (code !== 0) throw new Error(`migrations failed against ${url}`);
}

const suite = dockerOk ? describe : describe.skip;

suite('legacy public.credit_ledger created_by FK index (throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker', 'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql/data', '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60; i++) {
      if (pgReady()) break;
      await Bun.sleep(1000);
    }
    if (!pgReady()) throw new Error('test Postgres never became ready');

    // Legacy path: the pre-baseline table exists BEFORE any migration runs.
    psql(LEGACY_TABLE_SQL);
    expect(fkCovered(URL)).toBe(false);

    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');

    // Fresh path: a second, pristine database, migrated in the same run.
    psql('create database fresh');
    await migrateDatabase(FRESH_URL);
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('the legacy table FK gains a valid covering index named for the baseline column', () => {
    expect(fkCovered(URL)).toBe(true);
    expect(
      psql(`
        select i.indisvalid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_index i on i.indexrelid = c.oid
         where n.nspname = 'public' and c.relname = 'idx_credit_ledger_created_by'
      `),
    ).toBe('t');
  });

  test('the migration records itself in the ledger on the legacy database', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION_NAME}'`),
    ).toBe('1');
  });

  test('a fresh database keeps no public.credit_ledger and gets no index, and the migration still records itself', () => {
    expect(psqlOn(FRESH_URL, `select to_regclass('public.credit_ledger') is null`)).toBe('t');
    expect(psqlOn(FRESH_URL, `select to_regclass('public.idx_credit_ledger_created_by') is null`)).toBe('t');
    expect(
      psqlOn(FRESH_URL, `select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION_NAME}'`),
    ).toBe('1');
  });
});
