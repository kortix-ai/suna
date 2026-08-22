-- Migration: drop_llm_gateway_project_override
--
-- `llm_gateway` is no longer a feature flag: gateway mode is the only session
-- mode (apps/api/src/feature-flags/registry.ts no longer registers the key, the
-- PATCH /features route 400s it, and session provisioning always injects
-- KORTIX_LLM_*). A stored `projects.metadata.experimental.llm_gateway` override
-- is already INERT — resolveFeatureFlags iterates the registry, not the stored
-- map, and FeatureFlagMapSchema is a non-strict object that strips unknown keys
-- on parse. This pass removes the stale key so stored metadata matches the
-- registry. DATA only, no DDL.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: removes one jsonb sub-key no deployed code reads. An API
-- replica still running the pre-removal image resolves the key through the
-- registry's platformDefault (LLM_GATEWAY_DEFAULT_ENABLED, default true) when
-- the override is absent, which is the same answer as the retired override
-- being inert. No column, table, constraint, index, or enum value changes.
--
-- backfill-safe: kortix.projects, bounded to the rows that still carry the
-- key (dev: see the row-count recorded in the PR; expected tens to low
-- hundreds, never the whole table). Single idempotent UPDATE with no DDL in
-- this transaction, so the only locks taken are row locks on the matched rows
-- for the duration of one jsonb `#-` rewrite each; concurrent writers on
-- other rows do not queue. Re-running matches zero rows.
UPDATE kortix.projects
SET metadata = metadata #- ARRAY['experimental', 'llm_gateway']::text[]
WHERE metadata -> 'experimental' ? 'llm_gateway';
