-- Migration: validate_project_model_generation_config_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 2/2: validate the NOT VALID CHECK constraint added in the
-- previous migration (20260718164553217_add_project_model_generation_config.sql).
-- VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock (does not
-- block reads/writes) and every existing row already satisfies it trivially
-- (the column's own DEFAULT is '{}', a valid jsonb object), so this
-- completes near-instantly regardless of table size.

ALTER TABLE "kortix"."project_llm_routing_policies"
  VALIDATE CONSTRAINT "project_llm_routing_policies_gen_config_object_check";
