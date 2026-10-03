import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-basejump-accounts-rls-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999, and an outbound socket from the suite can
// transiently own a port in it — Docker then fails the run with
// `bind: address already in use` (see credit-rpc-overloads.test.ts).
const PORT = Number(process.env.BASEJUMP_ACCOUNTS_RLS_TEST_PORT || 5442);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const POLICY = 'Accounts are viewable by primary owner';
const MIGRATION = '20261002213831930_basejump_accounts_rls_initplan';
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const OWNER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function psql(sql: string): string {
  // -q drops command tags (SET, BEGIN, ...) so a multi-statement query that
  // ends in a SELECT returns only that SELECT's rows.
  const res = sh(['psql', url, '-q', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

/**
 * basejump-schema policies that still evaluate an auth.*() function once per
 * row — the exact predicate of Supabase's `auth_rls_initplan` performance
 * advisor lint (splinter lints/0003): a policy whose qual calls auth.uid()
 * (or jwt/role/email) without wrapping it in `(select ...)` re-evaluates it
 * for every row. Empty means the advisor finding is cleared.
 */
function perRowAuthPolicies(): string[] {
  const raw = psql(
    `select schemaname || '.' || tablename || ' | ' || policyname
     from pg_policies
     where schemaname = 'basejump'
       and ((qual like '%auth.uid()%' and lower(qual) not like '%select auth.uid()%')
         or (qual like '%auth.jwt()%' and lower(qual) not like '%select auth.jwt()%')
         or (qual like '%auth.role()%' and lower(qual) not like '%select auth.role()%')
         or (qual like '%auth.email()%' and lower(qual) not like '%select auth.email()%'))
     order by 1`,
  );
  return raw ? raw.split('\n') : [];
}

/** Rows `authenticated` with jwt sub `sub` sees in basejump.accounts. */
function visibleAccounts(sub: string): string {
  return psql(
    `set session role authenticated;
     set session request.jwt.claim.sub = '${sub}';
     select string_agg(name, ',' order by id) from basejump.accounts;`,
  );
}

/**
 * Rebuild the production shape the advisor flagged: basejump.accounts with the
 * pre-migration policy that calls auth.uid() per row (prod pg_policies:
 * cmd SELECT, roles {authenticated}, qual `(primary_owner_user_id = auth.uid())`).
 * The schema USAGE / table SELECT grants mirror basejump's own setup; without
 * them `authenticated` cannot reach the schema at all and the policy is moot.
 */
function seedLegacyShape(): void {
  const prereqs = join(ROOT, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  const pre = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
  if (!pre.ok) throw new Error(`test-prereqs.sql failed: ${pre.stderr}`);
  psql(`
    -- Functional auth.uid(): the prereq stub returns NULL, so the RLS
    -- visibility checks below would assert nothing. Only a throwaway
    -- container runs this — never a real Supabase auth schema.
    create or replace function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create table basejump.accounts (
      id uuid primary key,
      primary_owner_user_id uuid not null,
      personal_account boolean not null default true,
      name text,
      created_at timestamptz not null default now()
    );
    alter table basejump.accounts enable row level security;
    create policy "${POLICY}" on basejump.accounts for select to authenticated
      using (primary_owner_user_id = auth.uid());
    grant usage on schema basejump to authenticated;
    grant select on basejump.accounts to authenticated;
    insert into basejump.accounts (id, primary_owner_user_id, name) values
      ('${ACCOUNT_A}', '${OWNER_A}', 'owner-a'),
      ('${ACCOUNT_B}', '${OWNER_B}', 'owner-b');
  `);
}

const suite = dockerOk ? describe : describe.skip;

suite('basejump.accounts RLS initplan (throwaway Postgres)', () => {
  let beforePerRow: string[] = [];
  let beforeVisibility = { a: '', b: '' };

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

    // Prod at the next release: basejump.accounts already exists with the
    // per-row policy when the migration batch runs. Capture the RED state,
    // then apply the whole corpus (the migration is its last member).
    seedLegacyShape();
    beforePerRow = perRowAuthPolicies();
    beforeVisibility = { a: visibleAccounts(OWNER_A), b: visibleAccounts(OWNER_B) };
    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 240_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('the seeded legacy shape reproduces the advisor finding (red before the fix)', () => {
    expect(beforePerRow).toEqual([`basejump.accounts | ${POLICY}`]);
  });

  test('the legacy policy still resolves auth.uid() per row and filters rows (red before the fix)', () => {
    expect(beforeVisibility).toEqual({ a: 'owner-a', b: 'owner-b' });
  });

  test('the migration ran in the applied batch', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`),
    ).toBe('1');
  });

  test('no basejump policy evaluates auth.*() per row after the migration', () => {
    expect(perRowAuthPolicies()).toEqual([]);
  });

  test('the recreated policy keeps its shape: same name, SELECT, authenticated, permissive, RLS on', () => {
    const row = psql(
      `select c.relrowsecurity || '|' || p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive
       from pg_policies p
       join pg_class c on c.relname = p.tablename
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
       where p.schemaname = 'basejump' and p.tablename = 'accounts'`,
    );
    expect(row).toBe(`true|${POLICY}|SELECT|{authenticated}|PERMISSIVE`);
    // The initplan form: the function call is wrapped in `(select ...)` and the
    // predicate is unchanged (left operand still primary_owner_user_id).
    const qual = psql(
      `select qual from pg_policies where schemaname = 'basejump' and tablename = 'accounts'
         and policyname = '${POLICY}'`,
    );
    expect(qual.toLowerCase()).toContain('select auth.uid()');
    expect(qual).toMatch(/primary_owner_user_id\s*=\s*\(.*auth\.uid\(\)/i);
  });

  test('row visibility is unchanged after the fix', () => {
    expect(visibleAccounts(OWNER_A)).toBe(beforeVisibility.a);
    expect(visibleAccounts(OWNER_B)).toBe(beforeVisibility.b);
  });
});

if (!dockerOk) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('basejump.accounts RLS initplan (docker unavailable — skipped)', () => {});
}
