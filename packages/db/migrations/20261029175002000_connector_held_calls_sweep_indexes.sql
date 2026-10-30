-- Migration: connector_held_calls_sweep_indexes
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Additive: two indexes on kortix.connector_held_calls. The table comes from
-- 20261029175001000_connector_held_calls in the same release and is empty at
-- deploy, so a plain CREATE INDEX holds its lock for no time.
--   idx_connector_held_calls_project    project transfer and purge read by project.
--   idx_connector_held_calls_input_age  the approval-expiry sweep wipes held input
--                                        older than 31 days; only rows that still
--                                        hold input are indexed.

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "idx_connector_held_calls_project" ON "kortix"."connector_held_calls" USING btree ("project_id");--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "idx_connector_held_calls_input_age" ON "kortix"."connector_held_calls" USING btree ("created_at") WHERE "kortix"."connector_held_calls"."input_enc" is not null;