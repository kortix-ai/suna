-- Migration: add_project_model_overrides
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Per-project model enablement, stored as EXCEPTIONS to the catalog default:
-- `{"anthropic/claude-opus-4-1": true, "glm-5.2": false}`.
--
-- Effective enablement is
--   overrides[id] ?? defaultEnabledModelIds(catalog).has(id)
-- where the default is "the newest model of each family" (see
-- packages/llm-catalog/src/enablement.ts). The latest models are therefore on
-- out of the box, and this column records only what an admin deliberately
-- changed.
--
-- Why exceptions and not the resolved set: a stored set freezes at write time,
-- so every later catalog addition (a newly connected provider, next month's
-- Claude release) would land OFF and need a manual click. Overrides let the
-- default keep tracking "the latest" forever.
--
-- This supersedes `disabled_models`, whose opt-out shape spelled BOTH "use the
-- default" and "the user turned everything on" as `[]` and so could not express
-- the default at all. `disabled_models` is deliberately left in place and
-- un-read for one release: old API pods still SELECT it on the gateway's hot
-- path, so dropping it here would 500 them mid-rollout. The contract step (DROP
-- COLUMN) is a follow-up migration once every pod is on this version.
--
-- No backfill: `disabled_models` is empty for every project (the feature is one
-- day old and gated behind MODEL_ENABLEMENT_ENABLED), and a faithful conversion
-- would need the live model catalog, which SQL has no access to. Any project
-- that HAD turned models off reverts to the default set.
--
-- Expand step 1/2 -- a constant DEFAULT '{}' is PG11+ metadata-only (no table
-- rewrite), and the CHECK is NOT VALID so it takes no validating scan /
-- write-blocking lock here. A later migration validates it (every existing row
-- gets the '{}' default, which the constraint admits).
ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD COLUMN "model_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "kortix"."project_llm_routing_policies"
  ADD CONSTRAINT "project_llm_routing_policies_model_overrides_object_check"
  CHECK (jsonb_typeof("model_overrides") = 'object') NOT VALID;
