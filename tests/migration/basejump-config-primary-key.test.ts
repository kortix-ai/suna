import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-basejump-config-pk-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999, and an outbound socket from the suite can
// transiently own a port in it — Docker then fails the run with
// `bind: address already in use` (see credit-rpc-overloads.test.ts).
const PORT = Number(process.env.BASEJUMP_CONFIG_PK_TEST_PORT || 5445);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const MIGRATION = '20261004035710009_basejump_config_primary_key';

function psql(sql: string): string {
  // -q drops command tags (SET, BEGIN, ...) so a multi-statement query that
  // ends in a SELECT returns only that SELECT's rows.
  const res = sh(['psql', url, '-q', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
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
     where c.conrelid = 'basejump.config'::regclass
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
     where table_schema = 'basejump' and table_name = 'config'
     order by ordinal_position
  `);
  return raw ? raw.split('\n') : [];
}

/**
 * Rebuild the production shape the advisor flagged (read live 2026-10-04
 * through the read-only Management API): four nullable columns with basejump's
 * defaults, one row, no key of any kind. Basejump's own SELECT policy on the
 * table is not part of this finding and is not reproduced.
 */
function seedLegacyShape(): void {
  const prereqs = join(ROOT, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  const pre = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
  if (!pre.ok) throw new Error(`test-prereqs.sql failed: ${pre.stderr}`);
  psql(`
    create table basejump.config (
      enable_team_accounts boolean default true,
      enable_personal_account_billing boolean default true,
      enable_team_account_billing boolean default true,
      billing_provider text default 'stripe'
    );
    insert into basejump.config (enable_team_accounts) values (true);
  `);
}

const suite = dockerOk ? describe : describe.skip;

suite('basejump.config primary key (throwaway Postgres)', () => {
  let existedBefore = '';
  let pkBefore: ReturnType<typeof primaryKey> = null;
  let rowsBefore = '';
  let colsBefore: string[] = [];

  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
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
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = sh([
        'docker',
        'exec',
        CONTAINER,
        'pg_isready',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ]).ok;
      if (ready) break;
      await Bun.sleep(1000);
    }
    if (!ready) throw new Error('test Postgres never became ready');

    // Prod at the next release: basejump.config already exists, keyless, when
    // the migration batch runs. Capture the RED state, then apply the whole
    // corpus (the migration is its last member).
    seedLegacyShape();
    existedBefore = psql(`select to_regclass('basejump.config') is not null`);
    pkBefore = primaryKey();
    rowsBefore = psql('select count(*) from basejump.config');
    colsBefore = columns();
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('the seeded legacy shape reproduces the advisor finding (red before the fix)', () => {
    expect(existedBefore).toBe('t');
    expect(pkBefore).toBeNull();
    expect(rowsBefore).toBe('1');
    expect(colsBefore).toHaveLength(4);
  });

  test('the migration ran in the applied batch', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`),
    ).toBe('1');
  });

  test('basejump.config carries exactly one valid primary key after the chain', () => {
    const pk = primaryKey();
    expect(pk).not.toBeNull();
    expect(pk?.constraint).toBe('config_pkey');
    expect(pk?.unique).toBe(true);
    expect(pk?.valid).toBe(true);
  });

  test('the key column is GENERATED ALWAYS AS IDENTITY and not null', () => {
    const raw = psql(`
      select a.attnotnull::text || '|' || coalesce(a.attidentity::text, '-')
        from pg_attribute a
       where a.attrelid = 'basejump.config'::regclass
         and a.attname = 'id'
         and not a.attisdropped
    `);
    expect(raw).toBe('true|a');
  });

  test('the pre-existing row survived: identity backfilled, original shape intact', () => {
    expect(psql('select count(*) from basejump.config')).toBe('1');
    expect(psql('select id from basejump.config')).toBe('1');
    expect(
      psql(
        `select enable_team_accounts || '|' || enable_personal_account_billing || '|' ||
                enable_team_account_billing || '|' || coalesce(billing_provider, '-')
           from basejump.config`,
      ),
      // bool::text renders 'true'/'false' (psql's t/f is display-only).
    ).toBe('true|true|true|stripe');
    // Purely additive: the four prod columns keep their order, types and
    // nullability; only the id column is new.
    expect(columns().slice(0, 4)).toEqual(colsBefore);
  });
});
