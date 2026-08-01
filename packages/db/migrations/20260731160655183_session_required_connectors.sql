-- Migration: session_required_connectors
--
-- Connector aliases a session REQUIRES, independent of whether anything is
-- connected to them yet. A binding row cannot carry this -- project_session_
-- connector_bindings.profile_id is NOT NULL, so a binding says "use THIS
-- connection", never "this session needs Gmail and has none".
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Pure expand step:
--   [x] Nullable with no default, so no existing row is rewritten.
--   [x] Existing API versions ignore the new column.
--   [x] New API versions read a NULL as "the caller declared no requirement",
--       which is byte-identical to today's behaviour.
--   [x] No index, constraint validation, drop, rename, or backfill is required.

ALTER TABLE "kortix"."project_sessions" ADD COLUMN "required_connectors" jsonb;
