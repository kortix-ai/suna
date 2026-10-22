-- Migration: audit_events_partition_snapshot
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Snapshot companion for 20261001225732090 (drop the event FK), 20261001225732505 (the
-- partitioned table) and 20261001225732973 (the swap).
--
-- This file exists only so `packages/db/drizzle/` records the shape kortix.ts now declares for
-- audit_events (primary key (event_id, occurred_at), the dedupe index with occurred_at, partial
-- request/correlation indexes) and for audit_webhook_deliveries (no FK on event_id). drizzle-kit
-- generated the DROP CONSTRAINT / DROP INDEX / ADD PRIMARY KEY / CREATE INDEX statements for
-- that diff, and they were REMOVED on purpose: the three migrations above already built the
-- partitioned table with exactly that shape, and re-running the statements against a 145M-row
-- table would rewrite it under a lock. Keeping the file (as a no-op) keeps the drizzle journal
-- tag from dangling, so the next `drizzle-kit generate` does not re-emit them.
SELECT 1;
