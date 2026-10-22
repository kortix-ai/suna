/**
 * The public.agents legacy SELECT policy drop, against a real PostgreSQL.
 *
 * The Supabase performance advisor (lint multiple_permissive_policies) flags
 * public.agents: two permissive SELECT policies, agents_select_marketplace and
 * agents_select_own, both with roles = {public}. agents_select_own is a
 * leftover of the retired Suna agent marketplace (pre-baseline
 * backend/supabase/migrations 20250524062639_agents_table.sql and
 * 20250529125628_agent_marketplace.sql) and exists only on databases that
 * predate the Kortix baseline. Its USING clause,
 * basejump.has_role_on_account(account_id), is the second disjunct of
 * agents_select_marketplace's USING clause, so permissive (ORed) policy
 * evaluation admits exactly the same rows with one policy as with two.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL): the
 * fixture recreates the legacy prod state — the table with the five policies
 * and the has_role_on_account function exactly as prod defines it — then
 * applies the migration and checks the catalog and the visible row set. Also
 * proves the run is idempotent and a no-op when the table is absent (the
 * fresh-install state).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_agents_select_own_policy.sql').scanSync({
    cwd: migrationDirectory,
  }),
);

/** basejump.has_role_on_account, verbatim from the prod catalog: one
 *  SECURITY DEFINER function whose optional second argument defaults to NULL.
 *  The lane template does not ship it (the baseline and the bootstrap stub do
 *  not create it); prod predates the baseline and still has it. */
const HAS_ROLE_FN = `
  create or replace function basejump.has_role_on_account(
    account_id uuid,
    account_role basejump.account_role default null::basejump.account_role
  )
  returns boolean
  language sql
  security definer
  set search_path to 'public'
  as $fn$
    select exists(
      select 1
      from basejump.account_user wu
      where wu.user_id = auth.uid()
        and wu.account_id = has_role_on_account.account_id
        and (
          wu.account_role = has_role_on_account.account_role
          or has_role_on_account.account_role is null
        )
    );
  $fn$;
`;

/** The legacy public.agents table with the five policies and the grants the
 *  prod catalog reports (default Supabase privileges), plus three fixture
 *  agents: a private one in account A, a public one in account A, and a
 *  private one in account B nobody in the fixture is a member of. Rerunnable:
 *  every test rebuilds the exact prod state from nothing. */
const FIXTURE = `
  drop table if exists public.agents;
  create table public.agents (
    agent_id uuid primary key,
    account_id uuid not null,
    name varchar(255) not null,
    is_default boolean default false,
    is_public boolean default false,
    metadata jsonb default '{}'::jsonb,
    updated_at timestamptz default now()
  );
  alter table public.agents enable row level security;

  create policy agents_select_own on public.agents
    for select
    using (basejump.has_role_on_account(account_id));

  create policy agents_select_marketplace on public.agents
    for select
    using (is_public = true or basejump.has_role_on_account(account_id));

  create policy agents_insert_own on public.agents
    for insert
    with check (basejump.has_role_on_account(account_id, 'owner'::basejump.account_role));

  create policy agents_update_own on public.agents
    for update
    using (basejump.has_role_on_account(account_id, 'owner'::basejump.account_role) AND ((NOT COALESCE(((metadata ->> 'is_suna_default'::text))::boolean, false)) OR (COALESCE(((metadata ->> 'is_suna_default'::text))::boolean, false) = true)));

  create policy agents_delete_own on public.agents
    for delete
    using (basejump.has_role_on_account(account_id, 'owner'::basejump.account_role) AND (is_default = false) AND (NOT COALESCE(((metadata ->> 'is_suna_default'::text))::boolean, false)));

  grant select on public.agents to anon, authenticated;

  delete from basejump.account_user where user_id in (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002'
  );
  insert into basejump.account_user (user_id, account_id, account_role) values
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a', 'member');

  insert into public.agents (agent_id, account_id, name, is_public) values
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'private-a', false),
    ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'public-a', true),
    ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'private-b', false);
`;

/** The four policies the migration must keep, in pg_policies order. */
const KEPT = [
  'agents_delete_own',
  'agents_insert_own',
  'agents_select_marketplace',
  'agents_update_own',
];

/** The probe identities: anon, a member of account A, and an authenticated
 *  user with no membership. Each probe's expected visible set. */
const PROBES = [
  { key: 'anon', role: 'anon', sub: '', expected: ['public-a'] },
  {
    key: 'member',
    role: 'authenticated',
    sub: '00000000-0000-4000-8000-000000000001',
    expected: ['private-a', 'public-a'],
  },
  {
    key: 'outsider',
    role: 'authenticated',
    sub: '00000000-0000-4000-8000-000000000002',
    expected: ['public-a'],
  },
] as const;

async function policyNames(client: pg.Client) {
  const { rows } = await client.query<{ policyname: string }>(
    `select policyname from pg_policies
      where schemaname = 'public' and tablename = 'agents'
      order by policyname`,
  );
  return rows.map((row) => row.policyname);
}

/** The advisor's multiple_permissive_policies state for public.agents: roles
 *  whose permissive SELECT policies overlap. */
async function overlappingSelectRoles(client: pg.Client) {
  const { rows } = await client.query<{ rolname: string }>(
    `select r.rolname from pg_policies p cross join pg_roles r
      where p.schemaname = 'public' and p.tablename = 'agents'
        and p.permissive = 'PERMISSIVE' and p.cmd in ('ALL', 'SELECT')
        and r.rolname in ('anon', 'authenticated', 'service_role')
        and ('public' = any(p.roles) or r.rolname = any(p.roles))
      group by r.rolname having count(*) > 1 order by r.rolname`,
  );
  return rows.map((row) => row.rolname);
}

/** Probe every identity's visible row set. Call inside a transaction: the
 *  probes use SET LOCAL. RESET ROLE between probes — a NOLOGIN role cannot
 *  SET ROLE to another one — and before returning, so the caller's next
 *  statement (the migration DDL) runs as the connecting role again. */
async function visibleByProbe(client: pg.Client) {
  const out: Record<string, string[]> = {};
  for (const probe of PROBES) {
    await client.query('reset role');
    await client.query(
      `set local role ${probe.role}; set local request.jwt.claim.sub = '${probe.sub}'`,
    );
    out[probe.key] = (
      await client.query<{ name: string }>('select name from public.agents order by name')
    ).rows.map((row) => row.name);
  }
  await client.query('reset role');
  return out;
}

async function migrationSql() {
  const name = migrationNames.at(0);
  if (!name) throw new Error('migration file missing — the exactly-one test reports it');
  return Bun.file(resolve(migrationDirectory, name)).text();
}

suite('drop legacy public.agents select policy migration — real PostgreSQL', () => {
  let client: pg.Client;

  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(HAS_ROLE_FN);
  });

  afterAll(async () => {
    await client?.end();
  });

  test('exactly one migration drops the legacy policy, and the fixture seeds the prod state', async () => {
    expect(migrationNames.length).toBe(1);
    await client.query(FIXTURE);
    expect(await policyNames(client)).toContain('agents_select_own');
    expect(await policyNames(client)).toContain('agents_select_marketplace');
    // The flagged state: more than one permissive SELECT policy per role.
    expect((await overlappingSelectRoles(client)).length).toBeGreaterThan(0);
  });

  test('the migration drops exactly the flagged policy, idempotently', async () => {
    const migration = await migrationSql();
    await client.query(FIXTURE);

    // node-pg-migrate runs each file in one transaction; mirror that.
    await client.query(`begin;\n${migration}\ncommit;`);
    expect(await policyNames(client)).toEqual(KEPT);
    expect(await overlappingSelectRoles(client)).toEqual([]);

    // A second run is a no-op: every statement is guarded.
    await client.query(`begin;\n${migration}\ncommit;`);
    expect(await policyNames(client)).toEqual(KEPT);
  });

  test('the visible row set is identical before and after the drop', async () => {
    const migration = await migrationSql();
    await client.query(FIXTURE);

    // SET LOCAL probes need a transaction; the migration DDL is transactional,
    // so the before and after states meet in one.
    await client.query('begin');
    const before = await visibleByProbe(client);
    await client.query(migration);
    const after = await visibleByProbe(client);
    await client.query('rollback');

    expect(after).toEqual(before);
    // Sanity on the equivalence itself: the probe sets are the RLS semantics,
    // not merely equal to each other.
    for (const probe of PROBES) expect(before[probe.key]).toEqual([...probe.expected]);
  });

  test('the migration is a no-op when the table is absent (fresh-install state)', async () => {
    const migration = await migrationSql();
    // Drop the table inside a transaction that rolls back, so the fresh
    // migrated database keeps its state. An unguarded DROP POLICY would fail
    // here (the relation does not resolve); the guard makes the migration a
    // silent no-op instead.
    await client.query('begin');
    await client.query('drop table if exists public.agents');
    await client.query(migration);
    expect(await policyNames(client)).toEqual([]);
    expect(await overlappingSelectRoles(client)).toEqual([]);
    await client.query('rollback');
    // The rollback restores the fixture state; the migration created nothing.
    expect((await policyNames(client)).length).toBe(5);
  });
});
