-- Migration: session_log_mirror_drained_guard
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Session Log Plan P8.2, Release B2: a guard, no DDL. This release deletes the
-- session-log backfill and its merge pass, so it can no longer move a v1 mirror
-- conversation (kortix.session_transcript_*) into the session log. A database
-- whose mirror still holds a conversation the backfill has not finished must
-- not run it: those conversations would stop showing.
--
-- The guard passes when the mirror is empty (a fresh, test or self-host
-- database), or when the backfill's state row says both passes finished
-- (drainedWithDeleted AND mergedMissing). Otherwise it raises: the deploy
-- stops before the rollout, and the previous version keeps serving. It reads
-- the one-row state table and probes one mirror row: no scan, no lock beyond
-- ACCESS SHARE. Release B3 repeats the same check before it drops the tables.
DO $$
DECLARE
  pass jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM kortix.session_transcript_mirrors) THEN
    SELECT s.state INTO pass FROM kortix.session_log_backfill_state s WHERE s.id = 'pass';
    IF NOT coalesce((pass ->> 'drainedWithDeleted')::boolean AND (pass ->> 'mergedMissing')::boolean, false) THEN
      RAISE EXCEPTION 'session log release refused: the v1 mirror holds rows and the session-log backfill has not finished (kortix.session_log_backfill_state id=pass: drainedWithDeleted=%, mergedMissing=%)',
        coalesce(pass ->> 'drainedWithDeleted', 'unset'), coalesce(pass ->> 'mergedMissing', 'unset')
        USING HINT = 'Run Kortix 0.14.9 until its API logs "the session logs hold every v1 mirror message", then upgrade again.';
    END IF;
  END IF;
END
$$;
