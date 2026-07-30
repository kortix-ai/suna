-- Migration: validate_project_disabled_models_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 2/2: validate the NOT VALID CHECK constraint added in the previous
-- migration (20260728201046743_add_project_disabled_models.sql). VALIDATE
-- CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock (does not block reads/
-- writes) and every existing row already satisfies it trivially (the column's
-- own DEFAULT is '[]', a valid jsonb array), so this completes near-instantly
-- regardless of table size.

ALTER TABLE "kortix"."project_llm_routing_policies"
  VALIDATE CONSTRAINT "project_llm_routing_policies_disabled_models_array_check";
