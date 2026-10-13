-- Migration: drop_legacy_account_deletion_cascade
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Removes the retired Suna backend's scheduled account-deletion machinery:
-- the pg_cron job `process-scheduled-account-deletions`, its SECURITY DEFINER
-- driver `public.process_scheduled_account_deletions()` and its cascade
-- `public.delete_user_data(uuid, uuid)`.
--
-- Why (KRTX-1517, dev identity churn): the job is still ARMED on every
-- database migrated from Suna (observed live on dev 2026-10-04, cron.job jobid
-- 123, `0 1 * * *`, role postgres). Its driver reads `account_deletion_requests`
-- UNQUALIFIED. On dev the postgres role's search_path IN THE postgres DATABASE
-- is `kortix, public, extensions` (pg_db_role_setting, verified live
-- 2026-10-04), so the unqualified name resolves to the Kortix table
-- `kortix.account_deletion_requests` — the very rows the Kortix API writes; a
-- search_path without `kortix` first finds no legacy
-- `public.account_deletion_requests` (the baseline removed it) and the driver
-- errors out harmlessly. Resolution therefore depends on the environment's
-- role-in-database setting, not on the code — which is exactly the hazard:
-- the filter is the LEGACY column `deletion_scheduled_for <= NOW()`. The
-- Kortix API writes that table with `scheduled_for` and leaves
-- `deletion_scheduled_for` NULL, so today nothing matches — inert by one
-- NULL, not by design. The moment any row carries a past
-- `deletion_scheduled_for` (an old build, a backfill, a manual edit — one such
-- 2025-12 row exists on dev), the 01:00 run executes the legacy
-- cascade `delete_user_data()` and then `DELETE FROM auth.users WHERE id = <user_id>`,
-- destroying the account's whole Kortix-visible identity while every Kortix
-- row keyed by that user id survives. Its per-block EXCEPTION WHEN OTHERS
-- handlers swallow every failure of the legacy tables (mostly gone), so the
-- function still returns TRUE and the auth.users delete still runs.
-- The Kortix API's own processor (`processScheduledDeletions` in
-- apps/api/src/billing/services/account-deletion.ts) reads `status` +
-- `scheduled_for` and is a separate, Kortix-owned path; this migration does not
-- touch the table or its rows.
--
-- mixed-version-safe: both functions exist only on databases migrated from the
-- retired Suna backend (fresh baseline installs never had them). A repo-wide
-- search finds no Kortix code calling either (the only in-repo references are
-- the migration comments above and the fixtures of two suites that reproduce
-- the prod state for THEIR OWN migrations and assert nothing about a later
-- one: packages/db/scripts/drop-legacy-file-uploads.integration.test.ts and
-- packages/db/scripts/drop-legacy-public-functions.integration.test.ts).
-- `delete_user_data` was deliberately kept alive by
-- 20260924205551453_drop_legacy_public_functions solely because this job
-- called it; removing the job here removes its only caller. The guard below
-- refuses the drop while any other function body or pg_cron command still
-- references either name, so an unexpected dependent fails the migration
-- instead of being taken with it.
DO $$
DECLARE
  legacy_driver oid := to_regprocedure('public.process_scheduled_account_deletions()');
  legacy_cascade oid := to_regprocedure('public.delete_user_data(uuid, uuid)');
  blocker text;
BEGIN
  -- 1. Unschedule the job first: a cron command is plain text and records no
  --    dependency, so the drops alone would leave the 01:00 run calling a
  --    missing function every day.
  --    The removal path is permission-shaped: on Supabase the cron schema is
  --    owned by supabase_admin and the migrate role holds EXECUTE on
  --    cron.unschedule but not DELETE on cron.job; in a bare fixture stub
  --    (cron.job created by hand, no extension) only plain SQL exists. So try
  --    unschedule on a job that is actually there, and fall back to the row
  --    delete; a job that is absent is already unscheduled.
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-scheduled-account-deletions') THEN
      BEGIN
        PERFORM cron.unschedule('process-scheduled-account-deletions');
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM cron.job WHERE jobname = 'process-scheduled-account-deletions';
      END;
    END IF;
  END IF;

  -- 2. Refuse while any OTHER function body still names either routine
  --    (house pattern of 20260924205551453_drop_legacy_public_functions).
  IF legacy_driver IS NOT NULL OR legacy_cascade IS NOT NULL THEN
    SELECT string_agg(
      format('%s.%s references the legacy account-deletion cascade', n.nspname, p.proname),
      '; '
    )
    INTO blocker
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND l.lanname IN ('sql', 'plpgsql')
      AND p.oid NOT IN (coalesce(legacy_driver, 0), coalesce(legacy_cascade, 0))
      AND p.prosrc ~* '\m(process_scheduled_account_deletions|delete_user_data)\M';
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'legacy account-deletion cascade drop refused, still referenced: %', blocker;
    END IF;

    -- 3. A pg_cron command referencing either name stops the migration too
  --    (the job row removed in step 1 no longer counts: it is gone).
    IF to_regclass('cron.job') IS NOT NULL THEN
      SELECT string_agg(format('pg_cron job %s references the legacy account-deletion cascade', jobname), '; ')
      INTO blocker
      FROM cron.job
      WHERE command ~* '\m(process_scheduled_account_deletions|delete_user_data)\M';
      IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'legacy account-deletion cascade drop refused, still referenced: %', blocker;
      END IF;
    END IF;

    -- 4. Drop the two functions with their exact signatures. No CASCADE: an
  --    unexpected dependent fails the migration instead of being taken with it.
    IF legacy_driver IS NOT NULL THEN
      DROP FUNCTION public.process_scheduled_account_deletions();
    END IF;
    IF legacy_cascade IS NOT NULL THEN
      DROP FUNCTION public.delete_user_data(uuid, uuid);
    END IF;
  END IF;
END
$$;
