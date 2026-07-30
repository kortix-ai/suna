-- Migration: project_session_connector_bindings_configured
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Pure expand step:
--   [x] The column has a constant default and does not rewrite existing rows.
--   [x] Existing API versions ignore the new column.
--   [x] New API versions read existing rows as not explicitly configured.
--   [x] No index, constraint validation, drop, rename, or backfill is required.

ALTER TABLE "kortix"."project_sessions" ADD COLUMN "connector_bindings_configured" boolean DEFAULT false NOT NULL;
