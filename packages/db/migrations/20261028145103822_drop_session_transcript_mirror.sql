-- Migration: drop_session_transcript_mirror
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Session Log Plan P8.2, Release B2: drop the v1 transcript mirror
-- (kortix.session_transcript_mirrors, kortix.session_transcript_messages) and
-- the two SQL functions that read it. The backfill and its merge pass wrote
-- every mirror conversation into the session log (kortix.session_log*); the
-- same release deletes that code. Kept: kortix.session_delete_due_at (the
-- retention purge reads it) and kortix.session_log_backfill_state (the API that
-- is live while this file applies reads it; Release B3 drops it).
--
-- Guard. A mirror with rows is dropped only when the backfill's state row says
-- both passes finished (drainedWithDeleted AND mergedMissing). An empty mirror
-- (a fresh, test or self-host database) passes. The guard reads the one-row
-- state table and probes one mirror row: no scan. A self-host that fails it
-- runs the previous release until its API logs "the session logs hold every
-- v1 mirror message", then upgrades.
--
-- Locks. DROP TABLE of the mirror also takes ACCESS EXCLUSIVE on
-- kortix.project_sessions (it drops the foreign key's triggers there) until
-- commit. LOCK TABLE takes the three tables first, in the order a session
-- delete takes them (the session row, then the cascade), so the drop cannot
-- deadlock with a delete. A busy table fails this file with 55P03 under the
-- 2 s lock_timeout and rolls it back: run the deploy again, never raise it.
--
-- mixed-version-safe: the API that is live while this applies (Release B1,
-- #10782, and the merge pass, #10827/#10837/#10928) reads and writes neither
-- table once mirrorDrained() is true, and this guard requires the same state:
-- the conversion (fork, restore, lost-session recovery), the /log and v1
-- transcript reads, the retention purge, the project transfer and the backfill
-- tick all skip the mirror then. One read is not gated: the reply count of a
-- space session list (session-reply-counts.ts) reads the mirror for a listed
-- session with no root-thread turn in its log. Until the new tasks serve, such
-- a list answers 500 (42P01) on an old task. The foreign-key cascade from
-- kortix.project_sessions goes with the tables.
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
        USING HINT = 'Run the previous Kortix release until its API logs "the session logs hold every v1 mirror message", then upgrade again.';
    END IF;
  END IF;

  DROP FUNCTION IF EXISTS kortix.mirror_messages_missing_from_log(text[], timestamptz);
  DROP FUNCTION IF EXISTS kortix.mirror_sessions_without_log(timestamptz);

  -- A SQL function body or a pg_cron command records no pg_depend row: a plain
  -- DROP would succeed and leave it broken. Refuse instead.
  SELECT string_agg(format('%s.%s(%s) references the v1 mirror', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND p.prosrc ~* '\msession_transcript_(mirrors|messages)\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'session_transcript_mirrors drop refused, still referenced: %', blocker;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$
      SELECT string_agg(format('pg_cron job %s references the v1 mirror', jobname), '; ')
      FROM cron.job WHERE command ~* '\msession_transcript_(mirrors|messages)\M'
    $cron$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'session_transcript_mirrors drop refused, still referenced: %', blocker;
    END IF;
  END IF;
END
$$;

-- RESTRICT: an unexpected dependent (a view, another table's foreign key)
-- fails the file instead of going with the tables.
DROP TABLE kortix.session_transcript_messages RESTRICT;
DROP TABLE kortix.session_transcript_mirrors RESTRICT;
