-- Migration: mirror_sessions_without_log
--
-- Two functions, each the one definition of its predicate:
-- - kortix.session_delete_due_at(metadata): when a deleted session's rows purge is due,
--   which is also when its restore window ends. The retention purge
--   (apps/api/src/projects/session-log-purge.ts) and the next function read it.
-- - kortix.mirror_sessions_without_log(as_of): the sessions whose history is only in the v1
--   mirror and can still be read: mirror rows, no session_logs row, no purge marker, and
--   not deleted or still restorable at `as_of` (`deleted`: the second). The backfill selects from it
--   (apps/api/src/projects/session-log-backfill.ts). The Release B guard that drops the
--   mirror tables refuses while it returns a row, then drops this function with the tables.
-- Additive: no table changes, old code does not call either function.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The ISO instant `deleteSession` writes; any other stamp is never due (the purge skips it,
-- and a restore takes it back). 30 days = SESSION_DELETE_ROWS_DAYS in session-log-purge.ts.
-- No SET search_path, every name qualified: the planner can inline both functions.
CREATE OR REPLACE FUNCTION kortix.session_delete_due_at(metadata jsonb)
RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(metadata -> 'deletedAt') = 'string'
     AND metadata ->> 'deletedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'
    THEN (metadata ->> 'deletedAt')::timestamptz + make_interval(days => 30)
  END
$function$;

CREATE OR REPLACE FUNCTION kortix.mirror_sessions_without_log(as_of timestamptz DEFAULT now())
RETURNS TABLE (session_id text, created_at timestamptz, deleted boolean)
LANGUAGE sql STABLE
AS $function$
  SELECT s.session_id, s.created_at, kortix.session_delete_due_at(s.metadata) IS NOT NULL
    FROM kortix.session_transcript_mirrors m
    JOIN kortix.project_sessions s ON s.session_id = m.session_id
   WHERE NOT EXISTS (SELECT 1 FROM kortix.session_logs l WHERE l.session_id = m.session_id)
     AND EXISTS (SELECT 1 FROM kortix.session_transcript_messages t WHERE t.session_id = m.session_id)
     AND NOT EXISTS (SELECT 1 FROM kortix.session_content_purges p WHERE p.session_id = m.session_id)
     AND (kortix.session_delete_due_at(s.metadata) IS NULL OR kortix.session_delete_due_at(s.metadata) > as_of)
$function$;
