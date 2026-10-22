/**
 * The legacy scheduled account-deletion cascade drop, against a real PostgreSQL.
 *
 * KRTX-1517 (dev identity churn). The retired Suna backend's pg_cron job
 * `process-scheduled-account-deletions` is still ARMED on every database
 * migrated from Suna (observed live on dev 2026-10-04: cron.job jobid 123,
 * daily 01:00, role postgres). Its driver `public.process_scheduled_account_deletions()`
 * reads `account_deletion_requests` UNQUALIFIED — with the dev/postgres role
 * search_path (`kortix, public, extensions`) that resolves to the Kortix table
 * `kortix.account_deletion_requests`, the very rows the Kortix API writes —
 * and filters on the LEGACY column `deletion_scheduled_for <= NOW()`. The API
 * writes `scheduled_for` and leaves `deletion_scheduled_for` NULL, so today
 * nothing matches; the moment any row carries a past value (an old build, a
 * backfill, a manual edit — one such 2025-12 row exists on dev, cancelled,
 * which is the only reason it has not fired), the run executes
 * `delete_user_data()` and then `DELETE FROM auth.users WHERE id = <user_id>`:
 * the account's whole Kortix-visible identity is destroyed while every Kortix
 * row keyed by that user id survives. Every block of the cascade swallows its
 * own errors (the legacy tables are mostly gone), so the driver still reports
 * success and the auth.users delete still runs.
 *
 * This migration removes the machinery: the job row, the driver and the
 * cascade. The fixture recreates the exact prod state (both function bodies
 * are the dev definitions observed 2026-10-04 via pg_get_functiondef (the
 * driver's hard-coded admin key redacted — a secret the repo never commits; the
 * block is exception-wrapped in the legacy body itself, so the hazard is
 * unchanged), the
 * armed job row, a minimal auth.users, and a due Kortix deletion request),
 * proves the hazard fires before the migration, applies the migration the way
 * node-pg-migrate does (one transaction), and proves the machinery is gone and
 * a fresh victim survives it. Also proves the refusal guards and the run's
 * idempotence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_account_deletion_cascade.sql').scanSync({
    cwd: migrationDirectory,
  }),
);

/** The dev definition of public.delete_user_data(uuid, uuid) observed
 *  2026-10-04 (pg_get_functiondef, whitespace normalized): the account-deletion
 *  cascade the armed job serves. */
const LEGACY_CASCADE = `
  CREATE OR REPLACE FUNCTION public.delete_user_data(p_account_id uuid, p_user_id uuid)
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
  $function$;
`;

/** The dev definition of public.process_scheduled_account_deletions()
 *  observed 2026-10-04: reads account_deletion_requests unqualified (the
 *  Kortix table under the dev role search_path), filters on the legacy
 *  deletion_scheduled_for column, and deletes the auth user. */
const LEGACY_DRIVER = `
  CREATE OR REPLACE FUNCTION public.process_scheduled_account_deletions()
   RETURNS TABLE(processed_count integer, deleted_accounts integer, errors integer)
   LANGUAGE plpgsql
   SECURITY DEFINER
  AS $function$
  DECLARE
      v_deletion_request RECORD;
      v_account_id UUID;
      v_user_id UUID;
      v_processed INTEGER := 0;
      v_deleted INTEGER := 0;
      v_errors INTEGER := 0;
  BEGIN
      RAISE NOTICE 'Starting daily account deletion check at %', NOW();

      -- Find all deletion requests that are due and not cancelled/deleted
      FOR v_deletion_request IN
          SELECT id, account_id, user_id
          FROM account_deletion_requests
          WHERE deletion_scheduled_for <= NOW()
            AND is_cancelled = FALSE
            AND is_deleted = FALSE
          ORDER BY deletion_scheduled_for ASC
      LOOP
          v_processed := v_processed + 1;
          v_account_id := v_deletion_request.account_id;
          v_user_id := v_deletion_request.user_id;

          RAISE NOTICE 'Processing deletion request: %, account: %, user: %', 
              v_deletion_request.id, v_account_id, v_user_id;

          BEGIN
              -- Delete Daytona sandboxes via HTTP endpoint before deleting account data
              BEGIN
                  PERFORM net.http_post(
                      url := 'https://staging-api.suna.so/v1/internal/delete-account-sandboxes',
                      headers := json_build_object(
                          'Content-Type', 'application/json',
                          'X-Admin-Api-Key', '<redacted - the body hard-coded admin key, not part of this hazard>'
                      )::jsonb,
                      body := json_build_object('account_id', v_account_id)::text::jsonb,
                      timeout_milliseconds := 30000
                  );
                  RAISE NOTICE 'Requested sandbox deletion for account: %', v_account_id;
              EXCEPTION WHEN OTHERS THEN
                  RAISE WARNING 'Failed to delete sandboxes via HTTP for account %: %', v_account_id, SQLERRM;
                  -- Continue with deletion even if sandbox deletion fails
              END;

              -- Delete account data
              IF delete_user_data(v_account_id, v_user_id) THEN
                  -- Mark deletion request as completed
                  UPDATE account_deletion_requests
                  SET is_deleted = TRUE,
                      deleted_at = NOW(),
                      updated_at = NOW()
                  WHERE id = v_deletion_request.id;

                  -- Delete auth user
                  BEGIN
                      DELETE FROM auth.users WHERE id = v_user_id;
                      RAISE NOTICE 'Deleted auth user: %', v_user_id;
                  EXCEPTION WHEN OTHERS THEN
                      RAISE WARNING 'Error deleting auth user %: %', v_user_id, SQLERRM;
                  END;

                  v_deleted := v_deleted + 1;
                  RAISE NOTICE 'Successfully processed deletion for account: %', v_account_id;
              ELSE
                  RAISE WARNING 'Failed to delete data for account: %', v_account_id;
                  v_errors := v_errors + 1;
              END IF;
          EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'Error processing deletion request %: %', v_deletion_request.id, SQLERRM;
              v_errors := v_errors + 1;
          END;
      END LOOP;

      RAISE NOTICE 'Daily deletion check completed. Processed: %, Deleted: %, Errors: %', 
          v_processed, v_deleted, v_errors;

      RETURN QUERY SELECT v_processed, v_deleted, v_errors;
  END;
  $function$;
`;

/** The prod state the hazard lives in: the armed job row, its driver and its
 *  cascade, and the auth.users row shape the cascade deletes. */
/** The prod state the hazard lives in: the armed job row, its driver and its
 *  cascade (the definitions above), and the auth.users row shape the cascade
 *  deletes. */
const fixture = `
  create table if not exists auth.users (id uuid primary key);
  create schema if not exists cron;
  create table if not exists cron.job (
    jobid serial primary key,
    jobname text unique,
    schedule text,
    command text
  );
${LEGACY_CASCADE}
${LEGACY_DRIVER}
  insert into cron.job (jobname, schedule, command)
  select * from (values
    ('process-scheduled-account-deletions', '0 1 * * *', 'SELECT process_scheduled_account_deletions();')
  ) as v(jobname, schedule, command)
  where not exists (select 1 from cron.job where jobname = 'process-scheduled-account-deletions');
`;

const SEARCH_PATH = 'kortix, public, extensions';

/** The due Kortix deletion request the cascade would fire on, plus the auth
 *  user it destroys. Account id == user id (a personal account), the shape the
 *  API writes. Returns the user id. */
async function seedVictim(client: pg.Client, tag: string): Promise<string> {
  const userId = crypto.randomUUID();
  await client.query('insert into auth.users (id) values ($1)', [userId]);
  await client.query(
    `insert into kortix.account_deletion_requests
       (account_id, user_id, deletion_scheduled_for, scheduled_for, status, reason)
     values ($1, $1, now() - interval '1 hour', now() + interval '13 days', 'pending', $2)`,
    [userId, `legacy-cascade fixture ${tag}`],
  );
  return userId;
}

async function authUserExists(client: pg.Client, userId: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    'select exists (select 1 from auth.users where id = $1) as present',
    [userId],
  );
  return rows[0]?.present ?? false;
}

async function driverExists(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regprocedure('public.process_scheduled_account_deletions()') is not null as present`,
  );
  return rows[0]?.present ?? false;
}

async function cascadeExists(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regprocedure('public.delete_user_data(uuid, uuid)') is not null as present`,
  );
  return rows[0]?.present ?? false;
}

async function jobScheduled(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select exists (select 1 from cron.job where jobname = 'process-scheduled-account-deletions') as present`,
  );
  return rows[0]?.present ?? false;
}

async function migrationSql(): Promise<string> {
  const name = migrationNames.at(0);
  if (!name) throw new Error('migration file missing — the exactly-one test reports it');
  return Bun.file(resolve(migrationDirectory, name)).text();
}

/** node-pg-migrate runs each file in one transaction; mirror that. A raised
 *  error aborts the transaction, so the caller rolls back afterwards. */
function applyMigration(client: pg.Client, migration: string) {
  return client.query(`begin;\n${migration}\ncommit;`);
}

/** Run the legacy driver the way the armed pg_cron job does: as the postgres
 *  role with the dev search_path, where its unqualified
 *  `account_deletion_requests` resolves to the Kortix table. */
async function runLegacyDriver(client: pg.Client) {
  await client.query(`select set_config('search_path', $1, false)`, [SEARCH_PATH]);
  return client.query(
    `select processed_count, deleted_accounts, errors
       from public.process_scheduled_account_deletions()`,
  );
}

suite('drop legacy account-deletion cascade migration — real PostgreSQL', () => {
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

  test('exactly one migration drops the legacy cascade, and the fixture seeds the armed state', async () => {
    expect(migrationNames.length).toBe(1);
    expect(await jobScheduled(client)).toBe(true);
    expect(await driverExists(client)).toBe(true);
    expect(await cascadeExists(client)).toBe(true);
  });

  test('before the migration, the armed legacy job deletes the auth user of a due Kortix request', async () => {
    const victim = await seedVictim(client, 'red');
    const result = await runLegacyDriver(client);
    // The cascade ran: the request was consumed and the auth user is gone,
    // while the Kortix row that references the user survives untouched.
    expect(result.rows[0]).toEqual({ processed_count: 1, deleted_accounts: 1, errors: 0 });
    expect(await authUserExists(client, victim)).toBe(false);
    // The cascade consumed the request itself (its unqualified
    // `DELETE FROM account_deletion_requests` resolves to the same Kortix
    // table): no row remains for the account.
    const { rows: requestRows } = await client.query<{ n: string }>(
      'select count(*)::text as n from kortix.account_deletion_requests where user_id = $1',
      [victim],
    );
    expect(requestRows[0]?.n).toBe('0');
  });

  test('the migration refuses while another function body references either routine', async () => {
    const migration = await migrationSql();
    await expect(
      client.query(`begin;
        create function public.calls_legacy_cascade() returns void language plpgsql as
          $f$ begin perform public.delete_user_data(gen_random_uuid(), gen_random_uuid()); end $f$;
        ${migration}
        commit;`),
    ).rejects.toThrow(
      /legacy account-deletion cascade drop refused, still referenced: public\.calls_legacy_cascade/,
    );
    await client.query('rollback');
    expect(await cascadeExists(client)).toBe(true);
  });

  test('the migration refuses while another pg_cron command references either routine', async () => {
    const migration = await migrationSql();
    await expect(
      client.query(`begin;
        insert into cron.job (jobname, schedule, command)
        values ('fixture-calls-legacy', '0 1 * * *', 'SELECT public.process_scheduled_account_deletions();');
        ${migration}
        commit;`),
    ).rejects.toThrow(
      /legacy account-deletion cascade drop refused, still referenced: pg_cron job fixture-calls-legacy/,
    );
    await client.query('rollback');
    expect(await jobScheduled(client)).toBe(true);
  });

  test('the migration unschedules the job, drops both routines, and a fresh victim survives', async () => {
    const migration = await migrationSql();
    await applyMigration(client, migration);
    expect(await jobScheduled(client)).toBe(false);
    expect(await driverExists(client)).toBe(false);
    expect(await cascadeExists(client)).toBe(false);
    // A fresh due request can no longer fire any legacy deletion: the machinery
    // is gone, so the Kortix row is inert the way the API always intended.
    const survivor = await seedVictim(client, 'green');
    expect(await authUserExists(client, survivor)).toBe(true);
    const { rows: requestRows } = await client.query<{ isDeleted: boolean | null }>(
      'select is_deleted from kortix.account_deletion_requests where user_id = $1',
      [survivor],
    );
    expect(requestRows[0]?.isDeleted ?? false).toBe(false);
  });

  test('the migration is a no-op once the machinery is gone', async () => {
    const migration = await migrationSql();
    await applyMigration(client, migration);
    expect(await jobScheduled(client)).toBe(false);
    expect(await cascadeExists(client)).toBe(false);
  });
});
