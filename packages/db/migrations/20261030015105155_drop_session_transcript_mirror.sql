-- Migration: drop_session_transcript_mirror
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Session Log Plan P8.2, Release B3: drop the v1 transcript mirror
-- (kortix.session_transcript_mirrors, kortix.session_transcript_messages), the
-- two SQL functions that read it, and the backfill's state table
-- (kortix.session_log_backfill_state). The backfill and its merge pass wrote
-- every mirror conversation into the session log (kortix.session_log*), and
-- Release B2 deleted every reader and writer of the three tables. Kept:
-- kortix.session_delete_due_at (the retention purge reads it).
--
-- Guard. A mirror with rows is dropped only when the backfill's state row says
-- both passes finished (drainedWithDeleted AND mergedMissing). An empty mirror
-- (a fresh, test or self-host database) passes. The guard reads the one-row
-- state table and probes one mirror row: no scan. It reads the state before
-- this file drops it. Release B2's guard migration
-- (20261028154553825_session_log_mirror_drained_guard.sql) already refused a
-- database that fails it; this repeats the check right before the drop. A
-- self-host that fails it runs 0.14.9 until its API logs "the session logs
-- hold every v1 mirror message", then upgrades.
--
-- Locks. DROP TABLE of the mirror also takes ACCESS EXCLUSIVE on
-- kortix.project_sessions (it drops the foreign key's triggers there) until
-- commit. LOCK TABLE takes the three tables first, in the order a session
-- delete takes them (the session row, then the cascade), so the drop cannot
-- deadlock with a delete. A busy table fails this file with 55P03 under the
-- 2 s lock_timeout and rolls it back: run the deploy again, never raise it.
--
-- mixed-version-safe: the API that is live while this applies is Release B2
-- (v0.14.10), which reads and writes none of the three tables (B2 removed every reader,
-- including the space session list's reply-count fallback that 0.14.9 still
-- runs). A self-host that jumps from 0.14.9 straight to this release serves
-- 0.14.9 containers during its own rollout: their space session list answers
-- 500 (42P01) for a listed session with no root-thread turn until the new
-- containers serve. The foreign-key cascade from kortix.project_sessions goes
-- with the tables.
LOCK TABLE kortix.project_sessions, kortix.session_transcript_mirrors, kortix.session_transcript_messages IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  pass jsonb;
  blocker text;
BEGIN
  IF EXISTS (SELECT 1 FROM kortix.session_transcript_mirrors) THEN
    SELECT s.state INTO pass FROM kortix.session_log_backfill_state s WHERE s.id = 'pass';
    IF NOT coalesce((pass ->> 'drainedWithDeleted')::boolean AND (pass ->> 'mergedMissing')::boolean, false) THEN
      RAISE EXCEPTION 'session_transcript_mirrors drop refused: the v1 mirror holds rows and the session-log backfill has not finished (kortix.session_log_backfill_state id=pass: drainedWithDeleted=%, mergedMissing=%)',
        coalesce(pass ->> 'drainedWithDeleted', 'unset'), coalesce(pass ->> 'mergedMissing', 'unset')
        USING HINT = 'Run Kortix 0.14.9 until its API logs "the session logs hold every v1 mirror message", then upgrade again.';
    END IF;
  END IF;

  DROP FUNCTION IF EXISTS kortix.mirror_messages_missing_from_log(text[], timestamptz);
  DROP FUNCTION IF EXISTS kortix.mirror_sessions_without_log(timestamptz);

  -- A SQL function body or a pg_cron command records no pg_depend row: a plain
  -- DROP would succeed and leave it broken. Refuse instead.
  SELECT string_agg(format('%s.%s(%s) references a dropped table', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND p.prosrc ~* '\m(session_transcript_(mirrors|messages)|session_log_backfill_state)\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'session_transcript_mirrors drop refused, still referenced: %', blocker;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$
      SELECT string_agg(format('pg_cron job %s references a dropped table', jobname), '; ')
      FROM cron.job WHERE command ~* '\m(session_transcript_(mirrors|messages)|session_log_backfill_state)\M'
    $cron$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'session_transcript_mirrors drop refused, still referenced: %', blocker;
    END IF;
  END IF;
END
$$;

-- RESTRICT: an unexpected dependent (a view, another table's foreign key)
-- fails the file instead of going with the tables. The state table goes last:
-- the guard above read it.
DROP TABLE kortix.session_transcript_messages RESTRICT;
DROP TABLE kortix.session_transcript_mirrors RESTRICT;
DROP TABLE kortix.session_log_backfill_state RESTRICT;
