-- Migration: retire_scheduled_account_deletions_cron
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Retires the broken scheduled-account-deletion processor: the Supabase
-- pg_cron job `process-scheduled-account-deletions` and the two legacy
-- `public` functions it calls. The job's SQL reads the UNQUALIFIED
-- `account_deletion_requests`, which on every database older than the Kortix
-- baseline resolves through search_path to the pre-baseline legacy copy
-- `public.account_deletion_requests` — never the managed
-- `kortix.account_deletion_requests` the app writes — and its
-- `delete_user_data` cascade sweeps only legacy `public.*` tables. Nothing
-- has executed a scheduled deletion since the schema moved to `kortix`
-- (KRTX-1260: prod held 427 pending rows, 404 past their 14-day grace, with
-- 0 completed since 2026-04-11). The replacement processor is the API
-- singleton worker `startAccountDeletionSchedule`
-- (apps/api/src/billing/account-deletion-schedule.ts), wired in the same
-- change, which reads the managed table through the app's own repositories.
--
-- mixed-version-safe: the only caller of either dropped function is the
-- pg_cron job unscheduled in this same transaction — node-pg-migrate applies
-- each file in one transaction, so the daily job sees either the
-- pre-migration state (job present, functions present) or the post-migration
-- state (both gone), never a mix. No app code calls either function: a
-- repo-wide search of apps/, packages/, infra/ and scripts/ finds both names
-- only in migrations and their tests. Fresh baseline databases never had
-- them, so both statements are no-ops there; 20260924205551453 kept
-- public.delete_user_data solely because this job still called it, and
-- 20261003145424805 kept its body only to keep that call honest.
--
-- Deliberately NOT touched here: the legacy data `public.account_deletion_requests`
-- (264 pending-due rows, last write 2026-04-07, unreachable by the retired
-- job). That is data, not code: export-or-drop is an operator decision,
-- proposed in the change that wires the replacement processor, not executed
-- in a migration.
DO $$
DECLARE
  blocker text;
BEGIN
  -- Retire the job first. Guarded: a plain PostgreSQL without the pg_cron
  -- extension has no cron schema at all.
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-scheduled-account-deletions') THEN
      PERFORM cron.unschedule('process-scheduled-account-deletions');
    END IF;
    -- A pg_cron command is plain text and records no dependency, so the
    -- drops below could strand a surviving caller. Refuse instead.
    EXECUTE $q$
      SELECT string_agg(DISTINCT format('pg_cron job %s calls %s', jobname, t.name), '; ')
      FROM cron.job
      CROSS JOIN unnest(ARRAY['delete_user_data', 'process_scheduled_account_deletions']) AS t(name)
      WHERE command ~ ('\m' || t.name || '\M')
    $q$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'retire refused, still referenced: %', blocker;
    END IF;
  END IF;

  -- A function body that calls a dropped function records no dependency
  -- either. Refuse rather than leave the caller broken. The two functions
  -- being dropped are excluded: the wrapper's own body legitimately names
  -- the cascade it calls.
  SELECT string_agg(DISTINCT format('%s.%s calls %s', n.nspname, p.proname, t.name), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  CROSS JOIN unnest(ARRAY['delete_user_data', 'process_scheduled_account_deletions']) AS t(name)
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND NOT (p.oid IN (to_regprocedure('public.delete_user_data(uuid, uuid)'),
                       to_regprocedure('public.process_scheduled_account_deletions()')))
    AND p.prosrc ~ ('\m' || t.name || '\M');
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'retire refused, still referenced: %', blocker;
  END IF;

  DROP FUNCTION IF EXISTS public.process_scheduled_account_deletions();
  DROP FUNCTION IF EXISTS public.delete_user_data(uuid, uuid);
END
$$;
