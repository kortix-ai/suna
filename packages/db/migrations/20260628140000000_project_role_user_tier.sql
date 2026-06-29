-- Up Migration
--
-- Add the "User (read + run)" project-role tier as a real, assignable value of
-- the project_role enum (project_members.project_role / project_group_grants.
-- role). It already existed as a clone-template preset but was unassignable
-- because the enum only had manager/editor/viewer. User = Viewer + fire-triggers
-- (read + run sessions + operate automations, no editing/config) — a clean
-- superset between viewer and editor. Additive: no existing rows change.
-- ADD VALUE IF NOT EXISTS is idempotent (PG 9.6+).

ALTER TYPE "kortix"."project_role" ADD VALUE IF NOT EXISTS 'user';

-- Down Migration
--
-- Postgres cannot drop a single enum value. Reversal would require recreating
-- the type and rewriting both columns — left as a no-op (forward-only).
SELECT 1;
