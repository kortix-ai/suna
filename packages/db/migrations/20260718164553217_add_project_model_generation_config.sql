-- Migration: add_project_model_generation_config
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 1/2: a generic per-model generation-parameter config column
-- (reasoning effort, temperature, top_p, max output tokens) on the project
-- routing-policy table -- see ProjectModelGenerationConfig's doc comment on
-- projectLlmRoutingPolicies in packages/db/src/schema/kortix.ts.
--
-- Purely additive: jsonb DEFAULT '{}' is a constant default, so ADD COLUMN
-- is a metadata-only change on PG11+ (no table rewrite) even though it's
-- also NOT NULL -- every existing row gets '{}' without a rewrite. The CHECK
-- constraint is added NOT VALID so it never holds a full-table validation
-- scan here; VALIDATE CONSTRAINT is deferred to the next migration.
--   [x] New column has a constant DEFAULT -- no table rewrite, no backfill.
--   [x] CHECK constraint added NOT VALID; VALIDATE CONSTRAINT follows in the next migration.

ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD COLUMN "model_generation_config" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD CONSTRAINT "project_llm_routing_policies_gen_config_object_check"
  CHECK (jsonb_typeof("model_generation_config") = 'object') NOT VALID;
