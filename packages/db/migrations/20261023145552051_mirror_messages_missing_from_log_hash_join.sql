-- Migration: mirror_messages_missing_from_log_hash_join
--
-- kortix.mirror_messages_missing_from_log, same signature and same rows as
-- 20261023124001597_mirror_messages_missing_from_log.sql (the definition and its classes are
-- written there). Only the part lookup changes: each part key is one row, joined to the held keys
-- by hash, instead of `EXISTS (... key = ANY (keys))` against the materialized CTE, which runs
-- one CTE scan per part. Measured read-only on prod (2026-10-23): a session with 1,976 mirror
-- messages the log lacks ran over 120 s, now 1.5 s; 60 sampled sessions 38 s, now 9.3 s; output
-- identical (587 rows). Over the API pool's 25 s statement_timeout the merge pass could not
-- advance past such a batch.
--
-- Additive: CREATE OR REPLACE of a function only the merge pass calls; no table changes.
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
    SELECT m.session_id, m.message_id, x.ord, k.key
      FROM miss m
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts) = 'array' THEN m.parts ELSE '[]'::jsonb END) WITH ORDINALITY x(p, ord)
     CROSS JOIN LATERAL (VALUES
       (CASE WHEN NOT starts_with(x.p ->> 'id', '#') THEN 'id:' || (x.p ->> 'id') END),
       (CASE WHEN x.p ->> 'type' = 'text' THEN 'text:' || md5(x.p ->> 'text') END),
       (CASE WHEN x.p ->> 'type' = 'tool' THEN 'call:' || (x.p ->> 'callID') END),
       (CASE WHEN x.p ->> 'type' = 'tool' AND jsonb_typeof(x.p -> 'state' -> 'input') IS DISTINCT FROM 'null'
             THEN 'tool:' || md5(coalesce(x.p ->> 'tool', '') || ':' || (x.p -> 'state' -> 'input')::text) END)
     ) k(key)
     WHERE (x.p ->> 'type' = 'text' AND coalesce(x.p ->> 'text', '') <> '') OR x.p ->> 'type' = 'tool'
  ),
  found AS (
    SELECT pk.session_id, pk.message_id, pk.ord, bool_or(h.key IS NOT NULL) AS found
      FROM part_keys pk
      LEFT JOIN held h ON h.session_id = pk.session_id AND h.key = pk.key
     GROUP BY 1, 2, 3
  )
  SELECT m.session_id, m.message_id,
         CASE WHEN count(f.ord) = 0 THEN 'empty' WHEN bool_and(f.found) THEN 'present' ELSE 'missing' END
    FROM miss m
    LEFT JOIN found f ON f.session_id = m.session_id AND f.message_id = m.message_id
   GROUP BY m.session_id, m.message_id
$function$;
