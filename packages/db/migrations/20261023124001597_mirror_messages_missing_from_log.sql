-- Migration: mirror_messages_missing_from_log
--
-- One function, the one definition of "a v1 mirror message whose content the session log lacks":
-- kortix.mirror_messages_missing_from_log(sessions, as_of). The merge pass of the session-log
-- backfill selects from it (apps/api/src/projects/session-log-backfill.ts), and the Release B
-- guard that drops the mirror tables refuses while it returns a row with content = 'missing'
-- (as it refuses while kortix.mirror_sessions_without_log() returns a row). It is dropped with
-- the mirror tables.
--
-- One row per mirror message of a session that has a session log, no purge marker, and is not
-- deleted or is still restorable at `as_of` (the predicates of mirror_sessions_without_log), and
-- whose message id the log does not hold (live or tombstoned). `content` classifies it:
-- - 'empty': no text part with text and no tool part (a reasoning-, step- or file-only row).
-- - 'present': every such part is in the blocks of the same session's log, under any message id:
--   a text part by its part id (a block id) or md5(text) of a text block or a compaction summary;
--   a tool part by its part id, its callID, or md5(tool ':' input) of a tool_call block with an
--   input. An id that starts with '#' (fromV1's id for a part without one) never matches. The
--   part id covers a text the log offloaded (a preview) or the mirror cut at 200,000 characters.
-- - 'missing': at least one such part is not in the log.
-- `sessions` NULL: every session with a log.
--
-- Additive: no table changes, old code does not call it.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.mirror_messages_missing_from_log(sessions text[] DEFAULT NULL, as_of timestamptz DEFAULT now())
RETURNS TABLE (session_id text, message_id text, content text)
LANGUAGE sql STABLE
AS $function$
  WITH miss AS MATERIALIZED (
    SELECT t.session_id, t.message_id, t.parts
      FROM kortix.session_transcript_messages t
      JOIN kortix.session_logs l ON l.session_id = t.session_id
      JOIN kortix.project_sessions s ON s.session_id = t.session_id
     WHERE t.session_id = ANY (coalesce(sessions, ARRAY(SELECT x.session_id FROM kortix.session_logs x)))
       AND NOT EXISTS (SELECT 1 FROM kortix.session_log_messages lm WHERE lm.session_id = t.session_id AND lm.message_id = t.message_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.session_content_purges p WHERE p.session_id = t.session_id)
       AND (kortix.session_delete_due_at(s.metadata) IS NULL OR kortix.session_delete_due_at(s.metadata) > as_of)
  ),
  held AS MATERIALIZED (
    SELECT DISTINCT lm.session_id, k.key
      FROM kortix.session_log_messages lm
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(lm.record -> 'blocks') = 'array' THEN lm.record -> 'blocks' ELSE '[]'::jsonb END) b
     CROSS JOIN LATERAL (VALUES
       (CASE WHEN b ->> 'type' IN ('text', 'tool_call') AND NOT starts_with(b ->> 'id', '#') THEN 'id:' || (b ->> 'id') END),
       (CASE WHEN b ->> 'type' = 'text' AND coalesce(b ->> 'text', '') <> '' THEN 'text:' || md5(b ->> 'text') END),
       (CASE WHEN b ->> 'type' = 'compaction' AND coalesce(b ->> 'summary', '') <> '' THEN 'text:' || md5(b ->> 'summary') END),
       (CASE WHEN b ->> 'type' = 'tool_call' THEN 'call:' || (b ->> 'call_id') END),
       (CASE WHEN b ->> 'type' = 'tool_call' AND jsonb_typeof(b -> 'input') IS DISTINCT FROM 'null'
             THEN 'tool:' || md5(coalesce(b ->> 'name', '') || ':' || (b -> 'input')::text) END)
     ) k(key)
     WHERE lm.session_id IN (SELECT DISTINCT miss.session_id FROM miss) AND k.key IS NOT NULL
  ),
  part_keys AS (
    SELECT m.session_id, m.message_id, x.ord,
           ARRAY[
             CASE WHEN NOT starts_with(x.p ->> 'id', '#') THEN 'id:' || (x.p ->> 'id') END,
             CASE WHEN x.p ->> 'type' = 'text' THEN 'text:' || md5(x.p ->> 'text') END,
             CASE WHEN x.p ->> 'type' = 'tool' THEN 'call:' || (x.p ->> 'callID') END,
             CASE WHEN x.p ->> 'type' = 'tool' AND jsonb_typeof(x.p -> 'state' -> 'input') IS DISTINCT FROM 'null'
                  THEN 'tool:' || md5(coalesce(x.p ->> 'tool', '') || ':' || (x.p -> 'state' -> 'input')::text) END
           ] AS keys
      FROM miss m
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts) = 'array' THEN m.parts ELSE '[]'::jsonb END) WITH ORDINALITY x(p, ord)
     WHERE (x.p ->> 'type' = 'text' AND coalesce(x.p ->> 'text', '') <> '') OR x.p ->> 'type' = 'tool'
  ),
  found AS (
    SELECT pk.session_id, pk.message_id, pk.ord,
           EXISTS (SELECT 1 FROM held h WHERE h.session_id = pk.session_id AND h.key = ANY (pk.keys)) AS found
      FROM part_keys pk
  )
  SELECT m.session_id, m.message_id,
         CASE WHEN count(f.ord) = 0 THEN 'empty' WHEN bool_and(f.found) THEN 'present' ELSE 'missing' END
    FROM miss m
    LEFT JOIN found f ON f.session_id = m.session_id AND f.message_id = m.message_id
   GROUP BY m.session_id, m.message_id
$function$;
