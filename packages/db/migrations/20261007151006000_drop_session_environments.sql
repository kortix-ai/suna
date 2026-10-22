-- Migration: drop_session_environments
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- R6.6 follow-up: drop the compute-environment table of the deleted pi worker
-- split. PR #9189 (merged e60ed971f1, 2026-10-05) removed every reader and
-- writer: the 3 session environment routes, their service, the account-deletion
-- step and the orphan reaper. That code reached prod in v0.13.52
-- (release PR #9302); dev and staging run it too. The rows (3 on dev, last
-- write 2026-08-27) describe worker boxes that were already deleted, so they
-- are dropped with the table.
--
-- mixed-version-safe: every environment already runs v0.13.52 or later, which
-- has no reader or writer of this table (#9189 removed them one release
-- earlier, expand/contract deploy 1). An older replica cannot still be running
-- when this migration applies, because migrations run before the ECS rollout of
-- the release that carries it. The guard refuses when a SQL function or a
-- pg_cron command still names the table (neither records a pg_depend row), and
-- the DROP is RESTRICT so an unexpected dependent object fails the migration
-- instead of being taken with it.
DO $$
DECLARE
  blocker text;
BEGIN
  IF to_regclass('kortix.session_environments') IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(format('%s.%s references kortix.session_environments', n.nspname, p.proname), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND p.prosrc ~* '\msession_environments\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'session_environments drop refused, still referenced: %', blocker;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$
      SELECT string_agg(format('pg_cron job %s references kortix.session_environments', jobname), '; ')
      FROM cron.job WHERE command ~* '\msession_environments\M'
    $cron$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'session_environments drop refused, still referenced: %', blocker;
    END IF;
  END IF;

  DROP TABLE kortix.session_environments RESTRICT;
END
$$;
