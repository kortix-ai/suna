-- Migration: validate_voice_call_turns_role_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 2/2: validate the NOT VALID CHECK constraint added in the
-- previous migration (20260726151842728_voice_call_turns_allow_tool_role.sql).
-- VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock (does not block
-- reads/writes) and every existing row already satisfies it (it only widened the
-- allowed set from ('user','agent') to ('user','agent','tool')), so this completes
-- near-instantly regardless of table size.

ALTER TABLE "kortix"."voice_call_turns"
  VALIDATE CONSTRAINT "voice_call_turns_role_check";
