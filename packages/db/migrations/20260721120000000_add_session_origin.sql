-- Migration: add_session_origin
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Session ORIGIN (policy class) + the wrapper end-user a backend session acts
-- for. origin is derived from the caller's token kind at create time (never
-- the request body) and gates which overrides the caller may set; origin_ref
-- is the wrapper's opaque user id, non-null only on backend-origin sessions.
-- See apps/api/src/projects/lib/session-origin.ts and the KaaB v1 plan.
--
-- Purely additive:
--   [x] New enum type (no table touched).
--   [x] origin: constant DEFAULT 'user' -- metadata-only ADD COLUMN on PG11+,
--       every existing row reads 'user' without a table rewrite/backfill.
--   [x] origin_ref: nullable TEXT, no default -- metadata-only.
--   [x] No CHECK/FK/unique added -- no validation scan.

CREATE TYPE "kortix"."project_session_origin" AS ENUM (
  'user',
  'trigger',
  'schedule',
  'backend',
  'system'
);

ALTER TABLE "kortix"."project_sessions"
  ADD COLUMN "origin" "kortix"."project_session_origin" NOT NULL DEFAULT 'user',
  ADD COLUMN "origin_ref" text;
