/**
 * The `multiple_permissive_policies` fix for the legacy `public.credit_usage`,
 * against a real PostgreSQL.
 *
 * The Supabase performance advisor (splinter lints/0006) groups every
 * permissive policy by (table, role, action) — expanding FOR ALL to all four
 * actions — and flags a group with more than one. public.credit_usage carries
 * two permissive policies that both apply to every role (roles={public}), so
 * each role's SELECT group counts two and the advisor reports the table. The
 * migration scopes each policy to the only role its predicate can pass, which
 * leaves every (role, action) group with one policy and no predicate changed.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL): the
 * fixture rebuilds the legacy prod state — the pre-baseline table plus the two
 * policies exactly as KRTX-1140 (20261002214601090) recreated them, auth calls
 * wrapped, both roles={public} — then applies the migration and checks the
 * advisor predicate, the policy shape and the per-role row visibility before
 * and after. Also proves the run is idempotent and a no-op where the legacy
 * table is absent (fresh baseline installs).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_public_credit_usage_policy_roles.sql').scanSync({ cwd: migrationDirectory }),
);

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

/**
 * supabase/splinter lints/0006_multiple_permissive_policies.sql — the query
 * the hosted advisor runs — verbatim from `from pg_catalog.pg_policy` through
 * the `having` (the view wrapper only names it). Every permissive policy is
 * grouped by table, role and action (FOR ALL expands to the four actions);
 * a group with more than one policy is a finding.
 */
const ADVISOR_LINT = `
  select n.nspname as schema, c.relname as name, r.rolname as role, act.cmd as action
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on p.polrelid = c.oid
  join pg_catalog.pg_namespace n on c.relnamespace = n.oid
  join pg_catalog.pg_roles r
    on p.polroles @> array[r.oid]
    or p.polroles = array[0::oid]
  left join pg_catalog.pg_depend dep
    on c.oid = dep.objid
    and dep.deptype = 'e'
    and dep.classid = 'pg_catalog.pg_class'::regclass,
  lateral (
    select x.cmd
    from unnest((
      select case p.polcmd
        when 'r' then array['SELECT']
        when 'a' then array['INSERT']
        when 'w' then array['UPDATE']
        when 'd' then array['DELETE']
        when '*' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
        else array['ERROR']
      end as actions
    )) x(cmd)
  ) act(cmd)
  where c.relkind = 'r'
    and p.polpermissive
    and n.nspname not in ('_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault')
    and r.rolname not like 'pg_%'
    and r.rolname not like 'supabase%admin'
    and not r.rolbypassrls
    and dep.objid is null
  group by n.nspname, c.relname, r.rolname, act.cmd
  having count(1) > 1
`;

/** The lint's findings for the one table this issue is about. */
async function advisorFindings(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ role: string; action: string }>(
    `select * from (
       ${ADVISOR_LINT}
     ) f where f.schema = 'public' and f.name = 'credit_usage' order by f.role, f.action`,
  );
  return rows.map((row) => `${row.role}/${row.action}`);
}

/** cmd + roles + permissive + qual, one line per policy, sorted. */
async function policyShape(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(
    `select policyname || ' [' || cmd || ' roles=' || roles::text || ' ' || permissive || '] qual=' || qual as line
       from pg_policies
      where schemaname = 'public' and tablename = 'credit_usage'
      order by policyname`,
  );
  return rows.map((row) => row.line);
}

/** Rows each session sees in public.credit_usage under Supabase's role/GUC
 *  pairing (PostgREST switches to the role the JWT claim names), plus the one
 *  service-role write probe. */
async function accessMatrix(client: pg.Client): Promise<Record<string, string>> {
  const visible = async (role: string, gucs: [string, string][]): Promise<string> => {
    const sets = gucs.map(([name, value]) => `set local ${name} = '${value}'`).join('; ');
    await client.query(`begin; set local role ${role}; ${sets}`);
    try {
      const { rows } = await client.query<{ seen: string | null }>(
        `select string_agg(description, ',' order by description) as seen from public.credit_usage`,
      );
      return rows[0]?.seen ?? '';
    } finally {
      await client.query('rollback');
    }
  };
  const matrix: Record<string, string> = {
    authenticated_own: await visible('authenticated', [['request.jwt.claim.sub', ACCOUNT_A]]),
    authenticated_other: await visible('authenticated', [['request.jwt.claim.sub', ACCOUNT_B]]),
    anon: await visible('anon', [['request.jwt.claim.role', 'anon']]),
    service_role: await visible('service_role', [['request.jwt.claim.role', 'service_role']]),
  };
  // The service role manages the table; a user cannot write at all (no write
  // grant, and the user policy is SELECT-only).
  await client.query(
    "begin; set local role service_role; set local request.jwt.claim.role = 'service_role'",
  );
  await client.query(
    `insert into public.credit_usage (account_id, amount_dollars, description)
     values ('${ACCOUNT_B}', 9.00, 'svc-write-probe')`,
  );
  await client.query("delete from public.credit_usage where description = 'svc-write-probe'");
  await client.query('rollback');
  // The denied insert aborts its batch mid-transaction; clean the session up
  // before the caller issues anything else.
  await expect(
    client.query(
      `begin; set local role authenticated;
       set local request.jwt.claim.sub = '${ACCOUNT_A}';
       insert into public.credit_usage (account_id, amount_dollars, description)
       values ('${ACCOUNT_A}', 5.00, 'user-write-probe')`,
    ),
  ).rejects.toThrow(/permission denied/);
  await client.query('rollback');
  return matrix;
}

/**
 * Rebuild the legacy prod shape the advisor flagged: the pre-baseline table
 * plus the two policies exactly as prod carries them after KRTX-1140
 * (20261002214601090) — auth calls wrapped, no explicit role, so both policies
 * apply to every role. The functional auth functions stand in for Supabase's
 * (the prereq stubs return NULL, which would make the visibility checks
 * assert nothing); each suite gets its own cloned database, and a real
 * Supabase auth schema keeps its platform-owned functions untouched.
 */
const fixture = `
  do $auth$ begin
    create or replace function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create or replace function auth.role() returns text language sql stable as
      'select coalesce(nullif(current_setting(''request.jwt.claim.role'', true), ''''), ''anon'')';
  exception when insufficient_privilege then null; end $auth$;
  create table if not exists public.credit_usage (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null,
    amount_dollars numeric(10,2) not null,
    description text
  );
  alter table public.credit_usage enable row level security;
  drop policy if exists "Users can view their own credit usage" on public.credit_usage;
  drop policy if exists "Service role can manage all credit usage" on public.credit_usage;
  create policy "Users can view their own credit usage" on public.credit_usage
    for select using ((select auth.uid()) = account_id);
  create policy "Service role can manage all credit usage" on public.credit_usage
    using ((select auth.role()) = 'service_role'::text);
  grant select on public.credit_usage to anon, authenticated;
  grant select, insert, update, delete on public.credit_usage to service_role;
  truncate public.credit_usage;
  insert into public.credit_usage (account_id, amount_dollars, description) values
    ('${ACCOUNT_A}', 1.00, 'acct-a'),
    ('${ACCOUNT_A}', 2.00, 'acct-a-2'),
    ('${ACCOUNT_B}', 3.00, 'acct-b');
`;

async function migrationSql(): Promise<string> {
  const name = migrationNames.at(0);
  if (!name) throw new Error('migration file missing — the exactly-one test reports it');
  return Bun.file(resolve(migrationDirectory, name)).text();
}

suite('public.credit_usage policy roles migration — real PostgreSQL', () => {
  let client: pg.Client;
  let beforeFindings: string[] = [];
  let beforeMatrix: Record<string, string> = {};

  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(fixture);
    // RED, for the stated reason: both policies are permissive and apply to
    // every role, so every role's SELECT group counts two — exactly what the
    // prod advisor reported on 2026-10-02.
    beforeFindings = await advisorFindings(client);
    beforeMatrix = await accessMatrix(client);
  }, 30_000);

  afterAll(async () => {
    await client?.end();
  });

  test('exactly one migration scopes the legacy policies, and the fixture seeds the prod state', async () => {
    expect(migrationNames.length).toBe(1);
    const shape = await policyShape(client);
    expect(shape).toContain(
      'Users can view their own credit usage [SELECT roles={public} PERMISSIVE] qual=(( SELECT auth.uid() AS uid) = account_id)',
    );
    expect(shape).toContain(
      "Service role can manage all credit usage [ALL roles={public} PERMISSIVE] qual=(( SELECT auth.role() AS role) = 'service_role'::text)",
    );
  });

  test('the seeded legacy shape reproduces the advisor finding (red before the fix)', () => {
    expect(beforeFindings).toContain('anon/SELECT');
    expect(beforeFindings).toContain('authenticated/SELECT');
    expect(beforeFindings).toContain('service_role/SELECT');
  });

  test('the legacy shape already shows every role its post-migration rows (matrix is meaningful)', () => {
    expect(beforeMatrix).toEqual({
      authenticated_own: 'acct-a,acct-a-2',
      authenticated_other: 'acct-b',
      anon: '',
      service_role: 'acct-a,acct-a-2,acct-b',
    });
  });

  test('the migration scopes both policies; the advisor predicate stops flagging the table', async () => {
    const migration = await migrationSql();
    // node-pg-migrate runs each file in one transaction; mirror that.
    await client.query(`begin;\n${migration}\ncommit;`);

    expect(await advisorFindings(client)).toEqual([]);
    expect(await policyShape(client)).toEqual([
      "Service role can manage all credit usage [ALL roles={service_role} PERMISSIVE] qual=(( SELECT auth.role() AS role) = 'service_role'::text)",
      'Users can view their own credit usage [SELECT roles={authenticated} PERMISSIVE] qual=(( SELECT auth.uid() AS uid) = account_id)',
    ]);

    // A second run is a no-op: every statement is guarded.
    await client.query(`begin;\n${migration}\ncommit;`);
    expect(await advisorFindings(client)).toEqual([]);
  });

  test('row visibility and write access are unchanged after the fix', async () => {
    expect(await accessMatrix(client)).toEqual(beforeMatrix);
  });

  test('the migration is a no-op where the legacy table is absent (fresh baseline installs)', async () => {
    const migration = await migrationSql();
    // Drop the table inside a transaction that rolls back, so the fixture
    // state survives.
    await client.query(`begin;\ndrop table public.credit_usage;\n${migration}\nrollback;`);
    expect(await advisorFindings(client)).toEqual([]);
  });
});
