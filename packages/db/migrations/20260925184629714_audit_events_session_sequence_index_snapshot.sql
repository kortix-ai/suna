-- Migration: audit_events_session_sequence_index
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Snapshot companion for 20260925184641509_audit_events_session_sequence_index.concurrent.ts.
--
-- This file exists only so `packages/db/drizzle/` records the same shape
-- kortix.ts now declares: drizzle-kit generate emitted it with
--
--   CREATE INDEX "idx_audit_events_session_sequence"
--     ON "kortix"."audit_events" USING btree ("session_id","session_sequence","event_id");
--
-- and that statement was REMOVED on purpose, per the generator's own checklist
-- ("Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
-- `pnpm migrate:create <slug> --concurrent`; it blocks writes here"). The
-- concurrent sibling builds the index without blocking audit writers; by the
-- time this file runs on a fresh database the sibling may not have run yet, so
-- re-stating the statement here would also make the fresh-DB migration order
-- wrong. Keeping the file (as a no-op) keeps the drizzle journal tag from
-- dangling, so the next `drizzle-kit generate` does not re-emit the index.
