/**
 * The basejump.account_user legacy SELECT policy drop, against a real PostgreSQL.
 *
 * The Supabase performance advisor (lint auth_rls_initplan) flags
 * `users can view their own account_users` — its USING clause calls
 * auth.uid() per row. The policy is a leftover of the retired basejump
 * framework on databases that predate the baseline: nothing reads or writes
 * basejump.* (the API connects as postgres/service_role, web/mobile/SDK never
 * touch the schema) and a fresh install's bootstrap stub creates this table
 * without any policy. The migration drops exactly that policy and keeps the
 * two other legacy policies on the same table.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL): the
 * fixture recreates the legacy prod state — the stub table plus the three
 * policies basejump left on it — then applies the migration and checks the
 * catalog. Also proves the run is idempotent and a no-op when the whole
 * basejump schema is absent (rolled back).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_account_user_select_policy.sql').scanSync({
    cwd: migrationDirectory,
  }),
);

/** The stub table plus the supporting objects a legacy basejump database has. */
const fixture = `
  create table if not exists basejump.accounts (
    id uuid primary key,
    primary_owner_user_id uuid not null
  );
  create or replace function basejump.has_role_on_account(account_id uuid)
    returns boolean language sql stable as 'select true';
  create or replace function basejump.has_role_on_account(account_id uuid, role basejump.account_role)
    returns boolean language sql stable as 'select true';
  drop policy if exists "users can view their own account_users" on basejump.account_user;
  drop policy if exists "users can view their teammates" on basejump.account_user;
  drop policy if exists "Account users can be deleted by owners except primary account o" on basejump.account_user;
  create policy "users can view their own account_users" on basejump.account_user
    for select to authenticated using (user_id = auth.uid());
  create policy "users can view their teammates" on basejump.account_user
    for select to authenticated using (basejump.has_role_on_account(account_id) = true);
  -- Postgres truncates identifiers to 63 bytes; prod's catalog name ends at
  -- "...account o" (the framework's longer name does not survive creation).
  create policy "Account users can be deleted by owners except primary account o" on basejump.account_user
    for delete to authenticated using (
      (basejump.has_role_on_account(account_id, 'owner'::basejump.account_role) = true)
      and (user_id <> (select accounts.primary_owner_user_id from basejump.accounts where (account_user.account_id = accounts.id))));
`;

/** The two policies the migration must keep, in pg_policies order. Names are
 *  the catalog's — Postgres truncates identifiers at 63 bytes. */
const KEPT = [
  'Account users can be deleted by owners except primary account o',
  'users can view their teammates',
];

async function policyNames(client: pg.Client) {
  const { rows } = await client.query<{ policyname: string }>(
    `select policyname from pg_policies
      where schemaname = 'basejump' and tablename = 'account_user'
      order by policyname`,
  );
  return rows.map((row) => row.policyname);
}

async function migrationSql() {
  const name = migrationNames.at(0);
  if (!name) throw new Error('migration file missing — the exactly-one test reports it');
  return Bun.file(resolve(migrationDirectory, name)).text();
}

suite('drop legacy account_user select policy migration — real PostgreSQL', () => {
  let client: pg.Client;

  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(fixture);
  });

  afterAll(async () => {
    await client?.end();
  });

  test('exactly one migration drops the legacy policy, and the fixture seeds the prod state', async () => {
    expect(migrationNames.length).toBe(1);
    expect(await policyNames(client)).toContain('users can view their own account_users');
  });

  test('the migration drops exactly the flagged policy, idempotently', async () => {
    const migration = await migrationSql();

    // node-pg-migrate runs each file in one transaction; mirror that.
    await client.query(`begin;\n${migration}\ncommit;`);
    expect(await policyNames(client)).toEqual(KEPT);

    // A second run is a no-op: every statement is guarded.
    await client.query(`begin;\n${migration}\ncommit;`);
    expect(await policyNames(client)).toEqual(KEPT);
  });

  test('the migration is a no-op when the whole basejump schema is absent', async () => {
    const migration = await migrationSql();
    // Drop the schema inside a transaction that rolls back, so the fixture
    // state survives.
    await client.query(`begin;\ndrop schema basejump cascade;\n${migration}\nrollback;`);
  });
});
