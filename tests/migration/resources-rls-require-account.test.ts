import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-resources-rls-require-account-test';
// Host port for the throwaway container. MUST stay BELOW 32768: see
// credit-rpc-overloads.test.ts for the ephemeral-range collision.
const PORT = Number(process.env.RESOURCES_RLS_TEST_PORT || 5455);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const MIGRATION = '20261021131047526_resources_rls_require_account';
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const MEMBER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const STRANGER = 'cccccccc-0000-0000-0000-000000000003';
const POLICIES = {
  select: 'Account members can view resources for their accounts',
  update: 'Account members can update resources for their accounts',
  insert: 'Account members can insert resources for their accounts',
  delete: 'Account members can delete resources for their accounts',
};

function psql(sql: string): string {
  const res = sh(['psql', url, '-q', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

/**
 * Runs `sql` as `authenticated` with jwt sub `sub`, inside a rolled-back
 * transaction. Each statement is its own `-c`: psql prints only the last
 * result of a multi-statement `-c`, which here would be the ROLLBACK.
 */
function asUser(sub: string, sql: string): { ok: boolean; out: string } {
  const res = sh([
    'psql',
    url,
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-tA',
    '-c',
    'begin',
    '-c',
    'set local role authenticated',
    '-c',
    `set local request.jwt.claim.sub = '${sub}'`,
    '-c',
    sql,
    '-c',
    'rollback',
  ]);
  return { ok: res.ok, out: res.stdout.trim() };
}

function visible(sub: string): string {
  return asUser(
    sub,
    `select coalesce(string_agg(name, ',' order by name), '') from public.resources`,
  ).out;
}

function updatedNullRows(sub: string): string {
  return asUser(
    sub,
    `with u as (update public.resources set name = name where account_id is null returning 1)
     select count(*) from u`,
  ).out;
}

function insertAllowed(sub: string, accountId: string | null): boolean {
  const value = accountId ? `'${accountId}'` : 'null';
  return asUser(sub, `insert into public.resources (account_id, name) values (${value}, 'new-row')`)
    .ok;
}

/**
 * Rebuild the production shape (KRTX-2779): `public.resources` with the four
 * account-membership policies as 20261004173001004 left them. SELECT, UPDATE
 * and INSERT carry `account_id IS NULL OR`; DELETE does not.
 */
function seedLegacyShape(): void {
  const prereqs = join(ROOT, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  const pre = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
  if (!pre.ok) throw new Error(`test-prereqs.sql failed: ${pre.stderr}`);
  const member = `EXISTS (SELECT 1 FROM basejump.account_user
    WHERE account_user.account_id = resources.account_id
      AND account_user.user_id = (select auth.uid()))`;
  psql(`
    -- Functional auth.uid(): the prereq stub returns NULL. Only a throwaway
    -- container runs this, never a real Supabase auth schema.
    create or replace function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create table public.resources (
      id uuid primary key default gen_random_uuid(),
      account_id uuid,
      name text not null
    );
    alter table public.resources enable row level security;
    create policy "${POLICIES.select}" on public.resources for select to public
      using (account_id IS NULL OR ${member});
    create policy "${POLICIES.update}" on public.resources for update to public
      using (account_id IS NULL OR ${member});
    create policy "${POLICIES.insert}" on public.resources for insert to public
      with check (account_id IS NULL OR ${member});
    create policy "${POLICIES.delete}" on public.resources for delete to public
      using (${member});
    grant usage on schema basejump to authenticated;
    grant select on basejump.account_user to authenticated;
    grant select, insert, update, delete on public.resources to authenticated, service_role;
    insert into basejump.account_user (user_id, account_id, account_role)
      values ('${MEMBER_A}', '${ACCOUNT_A}', 'member');
    insert into public.resources (account_id, name) values
      ('${ACCOUNT_A}', 'row-a'),
      ('${ACCOUNT_B}', 'row-b'),
      (null, 'row-null');
  `);
}

const suite = dockerOk ? describe : describe.skip;

suite('public.resources RLS requires an account (throwaway Postgres)', () => {
  let before = {
    member: '',
    stranger: '',
    strangerUpdatesNull: '',
    strangerInsertsNull: false,
  };

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
    // Host TCP probe, not `docker exec pg_isready`: see worktree-migrate.test.ts.
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = sh(['psql', url, '-tAc', 'select 1']).ok;
      if (ready) break;
      await Bun.sleep(1000);
    }
    if (!ready) throw new Error('test Postgres never became ready');

    seedLegacyShape();
    before = {
      member: visible(MEMBER_A),
      stranger: visible(STRANGER),
      strangerUpdatesNull: updatedNullRows(STRANGER),
      strangerInsertsNull: insertAllowed(STRANGER, null),
    };
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
  });

  test('the seeded legacy shape admits a NULL-account row to any user (red before the fix)', () => {
    expect(before).toEqual({
      member: 'row-a,row-null',
      stranger: 'row-null',
      strangerUpdatesNull: '1',
      strangerInsertsNull: true,
    });
  });

  test('the migration ran in the applied batch', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`),
    ).toBe('1');
  });

  test('a user sees only rows of an account they belong to', () => {
    expect(visible(MEMBER_A)).toBe('row-a');
    expect(visible(STRANGER)).toBe('');
  });

  test('a user can no longer update a NULL-account row', () => {
    expect(updatedNullRows(STRANGER)).toBe('0');
  });

  test('an insert needs an account the user belongs to', () => {
    expect(insertAllowed(STRANGER, null)).toBe(false);
    expect(insertAllowed(MEMBER_A, null)).toBe(false);
    expect(insertAllowed(MEMBER_A, ACCOUNT_B)).toBe(false);
    expect(insertAllowed(MEMBER_A, ACCOUNT_A)).toBe(true);
  });

  test('the service role still reads every row', () => {
    expect(
      psql(
        `set role service_role; select string_agg(name, ',' order by name) from public.resources;`,
      ),
    ).toBe('row-a,row-b,row-null');
  });

  test('every policy keeps its name, command, role and permissiveness, and none admits NULL', () => {
    const rows = psql(
      `select policyname || '|' || cmd || '|' || roles::text || '|' || permissive
       from pg_policies where schemaname = 'public' and tablename = 'resources'
       order by policyname`,
    ).split('\n');
    expect(rows).toEqual([
      `${POLICIES.delete}|DELETE|{public}|PERMISSIVE`,
      `${POLICIES.insert}|INSERT|{public}|PERMISSIVE`,
      `${POLICIES.update}|UPDATE|{public}|PERMISSIVE`,
      `${POLICIES.select}|SELECT|{public}|PERMISSIVE`,
    ]);
    const nullBranches = psql(
      `select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'resources'
         and (coalesce(qual, '') ilike '%is null%' or coalesce(with_check, '') ilike '%is null%')`,
    );
    expect(nullBranches).toBe('0');
  });
});

if (!dockerOk) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('public.resources RLS requires an account (docker unavailable — skipped)', () => {});
}
