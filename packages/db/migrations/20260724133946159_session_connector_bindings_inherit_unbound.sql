-- Migration: session_connector_bindings_inherit_unbound
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Kortix-as-a-Backend: when a session sets connector_bindings, binding any alias
-- normally suppresses the project-default fallback for every OTHER (unbound)
-- alias ("all-or-nothing"). connector_bindings_inherit_unbound keeps that
-- fallback, so a caller can override just one connector (e.g. an end-user's own
-- account) without re-binding the rest. It can only ever inherit the project
-- DEFAULT profile, never another owner's, so it is safe for any origin. See
-- apps/api/src/projects/lib/session-connector-bindings.ts (resolveSessionConnectorProfile).
--
-- Purely additive:
--   [x] boolean, constant DEFAULT false, NOT NULL -- metadata-only ADD COLUMN on
--       PG11+, every existing row reads false without a table rewrite/backfill.
--   [x] No CHECK/FK/unique/index -- read only by the session PK lookup.

ALTER TABLE "kortix"."project_sessions"
  ADD COLUMN "connector_bindings_inherit_unbound" boolean DEFAULT false NOT NULL;
