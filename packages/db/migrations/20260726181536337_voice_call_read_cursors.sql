-- Migration: voice_call_read_cursors
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Where the Kortix agent's transcript READ POSITION lives.
--
-- `voice_call_turns.cursor` already made "what is new since X" a cheap indexed
-- range scan, but X was the AGENT'S problem: `read_transcript` took a cursor and
-- the agent had to thread the returned one back on every single call. An agent
-- that forgot -- or simply started a fresh turn without it -- passed 0 and
-- re-read the entire call. On a long call that is the same transcript re-billed
-- every turn for zero new information. Remembering the position server-side is
-- what makes the DEFAULT (a bare `read_transcript {}`) both cheap and correct.
--
-- WHY ITS OWN TABLE, not a column on project_sessions:
--   * project_sessions is hot and wide, and every live call would be writing to
--     it several times a minute purely for read bookkeeping -- row churn on the
--     table every session read touches, to record something no session read
--     cares about.
--   * The position is per CALL and is written on a completely different schedule
--     from anything else about a session. Its own narrow row keeps that write
--     off every other reader's tuples.
--   * It is DERIVED, disposable state: losing this table costs one duplicated
--     read, nothing more. That is a very different durability class from the
--     session row, and it should not be able to bloat or lock it.
-- Keyed by call_id (which IS the session id) because there is exactly one
-- reader that advances it: the Kortix agent driving the call from the inside.
-- The call PAGE's poll (r7.ts /voice-transcript, public-join-routes.ts) passes
-- an explicit cursor and deliberately never touches this row -- a human
-- scrolling the transcript must not consume the agent's unread.
--
-- Expand/contract checklist:
--   [x] CREATE TABLE only -- no existing table is touched, so no rewrite, no
--       backfill, and nothing to lock beyond the new relation.
--   [x] No index beyond the primary key: every access is by call_id, which the
--       PK already serves.
--   [x] No FK to project_sessions or voice_call_turns: same reasoning as
--       voice_call_turns itself -- a cascade delete here would be harmless, but
--       an FK would make writing this row depend on another table's liveness for
--       state that is pure bookkeeping.
--   [x] No DROP/RENAME/ALTER TYPE -- nothing for old code to trip over. Old API
--       pods never read or write this table; they keep passing explicit cursors,
--       which still work unchanged.

CREATE TABLE "kortix"."voice_call_read_cursors" (
  -- The call, which is also the session. One agent-side reader per call.
  "call_id"    text PRIMARY KEY,
  "project_id" uuid NOT NULL,
  -- The highest voice_call_turns.cursor actually HANDED to the agent. Only ever
  -- moves forward: the upsert carries a `WHERE cursor < excluded.cursor`, so two
  -- reads racing inside one call cannot let the slower one rewind the position
  -- and re-serve turns the agent has already paid for.
  "cursor"     bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
