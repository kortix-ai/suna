-- Migration: app_display
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A constant DEFAULT: Postgres 11+ adds the column without a table rewrite.
-- Old API code never reads or writes it.
ALTER TABLE "kortix"."apps" ADD COLUMN IF NOT EXISTS "display" jsonb DEFAULT '{}'::jsonb NOT NULL;
