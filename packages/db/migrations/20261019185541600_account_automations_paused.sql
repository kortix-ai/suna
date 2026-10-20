-- Migration: account_automations_paused
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Pause all automations (KRTX-1721): two nullable columns with no default on
-- accounts. ADD COLUMN without a default is a catalog-only change (no table
-- rewrite, no backfill); old code never reads the columns.

ALTER TABLE "kortix"."accounts" ADD COLUMN "automations_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."accounts" ADD COLUMN "automations_paused_by" uuid;