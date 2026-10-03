/**
 * The legacy `public.file_uploads` drop, against a real PostgreSQL.
 *
 * The Supabase performance advisor (lint auth_rls_initplan) flags all four
 * RLS policies of `public.file_uploads` — each evaluates auth.uid() per row.
 * The table is the leftover this finding exists for: the retired Suna
 * backend's upload metadata table, empty in prod, unreferenced by Kortix
 * code, and never created by the Kortix baseline (0000_bootstrap.sql). The
 * migration rewrites the one live function whose body still names the table
 * — the account-deletion cascade delete_user_data, served by the active
 * process-scheduled-account-deletions pg_cron job — without its dead
 * file_uploads block, then drops the table. It refuses (dropping nothing)
 * while the table still holds rows or while any other function body or
 * pg_cron command still names it — none of those callers records a
 * pg_depend row, so a plain DROP TABLE would succeed and leave the caller
 * broken.
 *
 * Runs against the lane's fresh migrated database (TEST_DATABASE_URL): the
 * fixture recreates the legacy prod state the finding is about — the table
 * with its prod columns, primary key and RLS, plus the four policies the
 * advisor names, with their prod `TO public` roles and clauses — then applies
 * the migration the way node-pg-migrate does (one transaction) and checks the
 * catalog. The table's other sub-objects (its four foreign keys, three check
 * constraints and one unique constraint) are omitted: they are dropped with
 * the table either way and no assertion depends on them. Also proves the run
 * is idempotent once the table is gone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_file_uploads.sql').scanSync({
    cwd: migrationDirectory,
  }),
);

/** The prod definition of public.delete_user_data(uuid, uuid) observed
 *  2026-10-02 (pg_get_functiondef, whitespace normalized): the account-deletion
 *  cascade whose file_uploads block this migration rewrites away. */
const LEGACY_DELETE_USER_DATA = `CREATE OR REPLACE FUNCTION public.delete_user_data(p_account_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_row_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Starting deletion for account_id: %, user_id: %', p_account_id, p_user_id;

    -- Delete storage files from file-uploads bucket
    BEGIN
        DELETE FROM storage.objects
        WHERE bucket_id = 'file-uploads'
          AND name LIKE p_account_id::text || '/%';
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % storage files from file-uploads bucket', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting storage files: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agent_runs WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_runs', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_runs: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM messages WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % messages', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting messages: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM threads WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % threads', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting threads: %', SQLERRM;
    END;

    BEGIN
        UPDATE agents
        SET current_version_id = NULL
        WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Nullified current_version_id for % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error nullifying agent versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agent_versions WHERE agent_id IN (
            SELECT agent_id FROM agents WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_versions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agents WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agents: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM projects WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % projects', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting projects: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM agent_templates WHERE creator_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_templates', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_templates: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM api_keys WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % api_keys', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting api_keys: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM credit_accounts WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % credit_accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting credit_accounts: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_subscriptions WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_subscriptions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_subscriptions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_customers WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_customers', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_customers: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.account_user WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_user', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_user: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM file_uploads WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % file_uploads records', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting file_uploads: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM account_deletion_requests WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_deletion_requests', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_deletion_requests: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.accounts WHERE id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting accounts: %', SQLERRM;
    END;

    RAISE NOTICE 'Completed deletion for account_id: %', p_account_id;
    RETURN TRUE;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Critical error in delete_user_data: %', SQLERRM;
        RETURN FALSE;
END;
$function$;`;

/** The prod table shape, the four policies the advisor flags, the two live
 *  pg_cron jobs, and the legacy delete_user_data (the one function whose body
 *  still names the table — the account-deletion cascade the active cron job
 *  calls). The stubs are non-clobbering: a migrated lane database already has
 *  auth.users/basejump.account_user from scripts/test-prereqs.sql, and an
 *  existing basejump.has_role_on_account is never replaced. */
const fixture = `
  create schema if not exists basejump;
  do $bj$ begin
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'basejump' and p.proname = 'has_role_on_account'
        and pg_get_function_identity_arguments(p.oid) = 'account_id uuid'
    ) then
      create function basejump.has_role_on_account(account_id uuid)
        returns boolean language sql stable as 'select true';
    end if;
  end $bj$;
  do $auth$ begin
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'auth' and p.proname = 'uid'
    ) then
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    end if;
  end $auth$;
  create table if not exists public.file_uploads (
    id uuid primary key default gen_random_uuid(),
    project_id uuid,
    thread_id uuid,
    agent_id uuid,
    account_id uuid not null,
    user_id uuid,
    bucket_name varchar not null,
    storage_path text not null,
    original_filename text not null,
    file_size bigint not null,
    content_type varchar,
    signed_url text,
    url_expires_at timestamptz,
    metadata jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  alter table public.file_uploads enable row level security;
  drop policy if exists "Users can view their own file uploads" on public.file_uploads;
  drop policy if exists "Users can create their own file uploads" on public.file_uploads;
  drop policy if exists "Users can update their own file uploads" on public.file_uploads;
  drop policy if exists "Users can delete their own file uploads" on public.file_uploads;
  create policy "Users can view their own file uploads" on public.file_uploads
    for select to public using ((user_id = auth.uid()) or (basejump.has_role_on_account(account_id) = true));
  create policy "Users can create their own file uploads" on public.file_uploads
    for insert to public with check ((user_id = auth.uid()) and (basejump.has_role_on_account(account_id) = true));
  create policy "Users can update their own file uploads" on public.file_uploads
    for update to public using (user_id = auth.uid());
  create policy "Users can delete their own file uploads" on public.file_uploads
    for delete to public using (user_id = auth.uid());
  create schema if not exists cron;
  create table if not exists cron.job (jobid serial primary key, jobname text, command text);
  insert into cron.job (jobname, command)
  select * from (values
    ('yearly-plan-monthly-refill', 'SELECT process_monthly_refills();'),
    ('process-scheduled-account-deletions', 'SELECT process_scheduled_account_deletions();')
  ) as v(jobname, command)
  where not exists (select 1 from cron.job);
  ${LEGACY_DELETE_USER_DATA}
`;

/** The four legacy policy names, in pg_policies order. */
const FLAGGED_POLICIES = [
  'Users can create their own file uploads',
  'Users can delete their own file uploads',
  'Users can update their own file uploads',
  'Users can view their own file uploads',
];

async function tableExists(client: pg.Client, qualified: string) {
  const { rows } = await client.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [qualified],
  );
  return rows[0]?.present ?? false;
}

async function policyNames(client: pg.Client) {
  const { rows } = await client.query<{ policyname: string }>(
    `select policyname from pg_policies
      where schemaname = 'public' and tablename = 'file_uploads'
      order by policyname`,
  );
  return rows.map((row) => row.policyname);
}

/** The body text of public.delete_user_data(uuid, uuid), or null when absent. */
async function deleteUserDataSource(client: pg.Client) {
  const { rows } = await client.query<{ prosrc: string | null }>(
    `select p.prosrc from pg_proc p
      where p.oid = to_regprocedure('public.delete_user_data(uuid, uuid)')`,
  );
  return rows[0]?.prosrc ?? null;
}

/** The identity facts a rewrite of delete_user_data must preserve. */
async function deleteUserDataRow(client: pg.Client) {
  const { rows } = await client.query<{
    prosecdef: boolean;
    provolatile: string;
    prorettype: boolean;
  }>(
    `select p.prosecdef, p.provolatile, p.prorettype = 'boolean'::regtype as prorettype
      from pg_proc p
      where p.oid = to_regprocedure('public.delete_user_data(uuid, uuid)')`,
  );
  return rows[0] ?? null;
}

async function migrationSql() {
  const name = migrationNames.at(0);
  if (!name) throw new Error('migration file missing — the exactly-one test reports it');
  return Bun.file(resolve(migrationDirectory, name)).text();
}

/** node-pg-migrate runs each file in one transaction; mirror that. A raised
 *  error aborts the transaction, so the caller rolls back afterwards. */
function applyMigration(client: pg.Client, migration: string) {
  return client.query(`begin;\n${migration}\ncommit;`);
}

suite('drop legacy file_uploads migration — real PostgreSQL', () => {
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

  test('exactly one migration drops the legacy table, and the fixture seeds the prod state', async () => {
    expect(migrationNames.length).toBe(1);
    expect(await tableExists(client, 'public.file_uploads')).toBe(true);
    expect(await policyNames(client)).toEqual(FLAGGED_POLICIES);
    // The object that flips the migration's outcome: the live account-deletion
    // cascade still names the table, and the cron jobs that call it exist.
    expect((await deleteUserDataSource(client)) ?? '').toContain('file_uploads');
    const { rows: jobs } = await client.query<{ jobname: string }>(
      'select jobname from cron.job order by jobname',
    );
    expect(jobs.map((row) => row.jobname)).toEqual([
      'process-scheduled-account-deletions',
      'yearly-plan-monthly-refill',
    ]);
  });

  test('the migration refuses to drop a table that holds rows', async () => {
    const migration = await migrationSql();
    await client.query(`begin;
      insert into public.file_uploads (account_id, bucket_name, storage_path, original_filename, file_size)
      values (gen_random_uuid(), 'fixture-bucket', 'fixture/path', 'fixture.txt', 1);`);
    await expect(applyMigration(client, migration)).rejects.toThrow(
      /legacy file_uploads drop refused, table holds 1 row/,
    );
    await client.query('rollback');
    expect(await tableExists(client, 'public.file_uploads')).toBe(true);
  });

  test('the migration refuses while a surviving function body references the table', async () => {
    const migration = await migrationSql();
    await expect(
      client.query(`begin;
        create function public.reads_legacy_uploads() returns void language sql as
          'select 1 from public.file_uploads';
        ${migration}
        commit;`),
    ).rejects.toThrow(
      /legacy file_uploads drop refused, still referenced: public\.reads_legacy_uploads/,
    );
    await client.query('rollback');
    expect(await tableExists(client, 'public.file_uploads')).toBe(true);
  });

  test('the migration refuses while a pg_cron command references the table', async () => {
    const migration = await migrationSql();
    await expect(
      client.query(`begin;
        insert into cron.job (jobname, command)
        values ('fixture-deletes-uploads', 'delete from file_uploads');
        ${migration}
        commit;`),
    ).rejects.toThrow(
      /legacy file_uploads drop refused, still referenced: pg_cron job fixture-deletes-uploads/,
    );
    await client.query('rollback');
    expect(await tableExists(client, 'public.file_uploads')).toBe(true);
  });

  test('the migration rewrites delete_user_data, drops the empty table and its four policies, leaves neighbours alone', async () => {
    const migration = await migrationSql();
    await applyMigration(client, migration);
    expect(await tableExists(client, 'public.file_uploads')).toBe(false);
    expect(await policyNames(client)).toEqual([]);
    // Scope: the drop takes only the table and its sub-objects.
    expect(await tableExists(client, 'basejump.account_user')).toBe(true);
    const { rows } = await client.query<{ present: boolean }>(
      `select to_regprocedure('basejump.has_role_on_account(uuid)') is not null as present`,
    );
    expect(rows[0]?.present ?? false).toBe(true);
    // The account-deletion cascade survives, minus its dead file_uploads
    // block: same identity, still SECURITY DEFINER, still returns boolean,
    // still runs its other deletions, and it no longer names the table.
    const source = await deleteUserDataSource(client);
    expect(source).not.toBeNull();
    expect(source).not.toContain('file_uploads');
    expect(source).toMatch(/delete from threads/i);
    expect(source).toContain('RETURN TRUE');
    const row = await deleteUserDataRow(client);
    expect(row).toEqual({ prosecdef: true, provolatile: 'v', prorettype: true });
    const { rows: called } = await client.query<{ ok: boolean }>(
      'select public.delete_user_data(gen_random_uuid(), gen_random_uuid()) as ok',
    );
    expect(called[0]?.ok ?? false).toBe(true);
    // The cron jobs the function serves are untouched.
    const { rows: jobs } = await client.query<{ n: string }>(
      'select count(*)::text as n from cron.job',
    );
    expect(jobs[0]?.n).toBe('2');
  });

  test('the migration is a no-op once the table is gone', async () => {
    const migration = await migrationSql();
    await applyMigration(client, migration);
    expect(await tableExists(client, 'public.file_uploads')).toBe(false);
  });
});
