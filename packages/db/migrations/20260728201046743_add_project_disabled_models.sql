-- Migration: add_project_disabled_models
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Per-project model enablement (opt-out): the wire-model ids a project has
-- turned OFF. The gateway refuses them everywhere; the picker hides them.
-- Expand step 1/2 — add the column (constant DEFAULT '[]' → PG11+ metadata-only,
-- no table rewrite) and add the array CHECK as NOT VALID so it takes no
-- validating scan / write-blocking lock here; a later migration validates it
-- (every existing row trivially satisfies it — the DEFAULT '[]' is an array).
ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD COLUMN "disabled_models" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD CONSTRAINT "project_llm_routing_policies_disabled_models_array_check"
  CHECK (jsonb_typeof("disabled_models") = 'array') NOT VALID;
