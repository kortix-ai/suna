import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-agents-backup-pk-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999, and an outbound socket from the suite can
// transiently own a port in it — Docker then fails the run with
// `bind: address already in use` (see credit-rpc-overloads.test.ts).
const PORT = Number(process.env.AGENTS_BACKUP_PK_TEST_PORT || 5449);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const MIGRATION = '20261004061056662_agents_backup_cleanup_pk';
const TABLE = 'public.agents_backup_cleanup_20250729';
const FRESH_DB = 'agents_backup_pk_fresh';

function psql(sql: string, db = 'postgres'): string {
  // -q drops command tags (SET, BEGIN, ...) so a multi-statement query that
  // ends in a SELECT returns only that SELECT's rows.
  const res = sh([
    'psql',
    `postgresql://postgres:postgres@127.0.0.1:${PORT}/${db}`,
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql,
  ]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

/** Run a committed migration file with psql (plain SQL, no runner needed). */
function runMigrationFile(db = 'postgres'): { ok: boolean; stderr: string } {
  const res = sh([
    'psql',
    `postgresql://postgres:postgres@127.0.0.1:${PORT}/${db}`,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    join(ROOT, 'packages', 'db', 'migrations', `${MIGRATION}.sql`),
  ]);
  return { ok: res.ok, stderr: res.stderr };
}

/**
 * The Supabase performance advisor's `no_primary_key` condition for one table:
 * a primary-key constraint backed by a valid unique index. `null` = flagged.
 */
function primaryKey(): {
  constraint: string;
  index: string;
  valid: boolean;
  unique: boolean;
} | null {
  const raw = psql(`
    select c.conname as constraint,
           i.indexrelid::regclass::text as index,
           i.indisvalid as valid,
           i.indisunique as unique
      from pg_constraint c
      left join pg_index i on i.indexrelid = c.conindid
     where c.conrelid = '${TABLE}'::regclass
       and c.contype = 'p'
     limit 1
  `);
  if (!raw) return null;
  const [constraint, index, valid, unique] = raw.split('|');
  return { constraint, index, valid: valid === 't', unique: unique === 't' };
}

/** The pre-migration prod shape: columns in order, type, nullability, default. */
function columns(): string[] {
  const raw = psql(`
    select ordinal_position || '|' || column_name || '|' || data_type || '|' ||
           is_nullable || '|' || coalesce(column_default, '-')
      from information_schema.columns
     where table_schema = 'public' and table_name = 'agents_backup_cleanup_20250729'
     order by ordinal_position
  `);
  return raw ? raw.split('\n') : [];
}

/**
 * Rebuild the production shape the advisor flagged (read live 2026-10-04
 * through the read-only Management API): a CTAS-style backup of `agents` —
 * 17 columns, every one nullable, zero indexes, zero constraints, two rows,
 * both with a NULL agent_id. Synthetic names only; row content is not the
 * finding and is not reproduced.
 */
function seedLegacyShape(): void {
  const prereqs = join(ROOT, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  const pre = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
  if (!pre.ok) throw new Error(`test-prereqs.sql failed: ${pre.stderr}`);
  psql(`
    create table public.agents_backup_cleanup_20250729 (
      agent_id uuid,
      account_id uuid,
      name character varying,
      description text,
      is_default boolean,
      created_at timestamp with time zone,
      updated_at timestamp with time zone,
      is_public boolean,
      marketplace_published_at timestamp with time zone,
      download_count integer,
      tags text[],
      current_version_id uuid,
      version_count integer,
      config jsonb,
      metadata jsonb,
      avatar character varying,
      avatar_color character varying
    );
    insert into public.agents_backup_cleanup_20250729 (name, created_at) values
      ('legacy-agent-one', now()),
      ('legacy-agent-two', now());
  `);
}

const suite = dockerOk ? describe : describe.skip;

suite('agents_backup_cleanup_20250729 primary key (throwaway Postgres)', () => {
  let existedBefore = '';
  let pkBefore: ReturnType<typeof primaryKey> = null;
  let rowsBefore = '';
  let nullAgentRowsBefore = '';
  let colsBefore: string[] = [];

  beforeAll(async () => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
    const up = sh([
      'docker',
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    // Host TCP probe: `docker exec pg_isready` answers over the unix socket,
    // which initdb's temporary socket-only server satisfies while nothing serves
    // TCP yet — the published port's proxy then accepts and closes the suite's
    // first `psql` (`server closed the connection unexpectedly`). See
    // worktree-migrate.test.ts for the full timeline and CI run 36153691220.
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = sh(['psql', url, '-tAc', 'select 1']).ok;
      if (ready) break;
      await Bun.sleep(1000);
    }
    if (!ready) throw new Error('test Postgres never became ready');

    // Prod at the next release: the legacy backup table already exists, keyless,
    // when the migration batch runs. Capture the RED state, then apply the whole
    // corpus (the migration is its last member).
    seedLegacyShape();
    existedBefore = psql(`select to_regclass('${TABLE}') is not null`);
    pkBefore = primaryKey();
    rowsBefore = psql(`select count(*) from ${TABLE}`);
    nullAgentRowsBefore = psql(`select count(*) from ${TABLE} where agent_id is null`);
    colsBefore = columns();
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
  });

  test('the seeded legacy shape reproduces the advisor finding (red before the fix)', () => {
    expect(existedBefore).toBe('t');
    expect(pkBefore).toBeNull();
    expect(rowsBefore).toBe('2');
    expect(nullAgentRowsBefore).toBe('2');
    expect(colsBefore).toHaveLength(17);
  });

  test('the migration ran in the applied batch', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`),
    ).toBe('1');
  });

  test('the table carries exactly one valid primary key after the chain', () => {
    const pk = primaryKey();
    expect(pk).not.toBeNull();
    expect(pk?.constraint).toBe('agents_backup_cleanup_20250729_pkey');
    expect(pk?.unique).toBe(true);
    expect(pk?.valid).toBe(true);
  });

  test('the key column is GENERATED ALWAYS AS IDENTITY and not null', () => {
    const raw = psql(`
      select a.attnotnull::text || '|' || coalesce(a.attidentity::text, '-')
        from pg_attribute a
       where a.attrelid = '${TABLE}'::regclass
         and a.attname = 'id'
         and not a.attisdropped
    `);
    expect(raw).toBe('true|a');
  });

  test('both pre-existing rows survived: identity backfilled, original shape intact', () => {
    expect(psql(`select count(*) from ${TABLE}`)).toBe('2');
    expect(psql(`select string_agg(id::text, ',' order by id) from ${TABLE}`)).toBe('1,2');
    expect(psql(`select string_agg(name, ',' order by id) from ${TABLE}`)).toBe(
      'legacy-agent-one,legacy-agent-two',
    );
    // The prod fact that motivated the shape: agent_id stays NULL — the fix
    // adds a key, it does not invent one for the source data.
    expect(psql(`select count(*) from ${TABLE} where agent_id is null`)).toBe('2');
    // Purely additive: the 17 prod columns keep their order, types and
    // nullability; only the id column is new.
    expect(columns().slice(0, 17)).toEqual(colsBefore);
  });

  test('re-applying the migration file is a no-op once the key exists', () => {
    const again = runMigrationFile();
    expect(again.ok).toBe(true);
    expect(
      psql(
        `select count(*) from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'p'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `select count(*) from pg_attribute where attrelid = '${TABLE}'::regclass and attname = 'id' and not attisdropped`,
      ),
    ).toBe('1');
  });

  test('the migration no-ops when the table is absent (fresh install)', () => {
    psql(`drop database if exists ${FRESH_DB}`);
    psql(`create database ${FRESH_DB}`);
    const fresh = runMigrationFile(FRESH_DB);
    expect(fresh.ok).toBe(true);
    expect(psql(`select to_regclass('${TABLE}') is not null`, FRESH_DB)).toBe('f');
    // No guard could ever have added a key to a table that does not exist.
    expect(
      psql(
        `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'agents_backup_cleanup_20250729'`,
        FRESH_DB,
      ),
    ).toBe('0');
    psql(`drop database ${FRESH_DB}`);
  });
});
