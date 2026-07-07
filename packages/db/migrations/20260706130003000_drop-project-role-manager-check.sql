-- Up Migration
--
-- Reverts the project-role "manager collapse" (Marko, 2026-07-05 → reverted
-- 2026-07-06): the 3 project roles — member / editor / MANAGER — are back.
-- The now-deleted migration
-- `20260705195215633_project-role-manager-collapse.sql` never reached
-- staging/prod, but it DID run on local dev DBs, which are left holding two
-- CHECK constraints that reject `manager` on `project_members` and
-- `project_group_grants`. Drop them so `manager` is writable again — the
-- `manager` value itself was never removed from the `kortix.project_role`
-- enum (Postgres can't drop an enum value), so no enum change is needed here,
-- only these two constraints.

ALTER TABLE "kortix"."project_members"
  DROP CONSTRAINT IF EXISTS "project_members_project_role_no_manager";

ALTER TABLE "kortix"."project_group_grants"
  DROP CONSTRAINT IF EXISTS "project_group_grants_role_no_manager";

-- Down Migration
--
-- Re-adds the CHECK constraints. Not reversible in the "restore any rows the
-- forward migration flipped to editor" sense — the collapse migration that
-- did that row rewrite is gone; this only restores the guard rails.
ALTER TABLE "kortix"."project_members"
  ADD CONSTRAINT "project_members_project_role_no_manager"
  CHECK (project_role != 'manager');

ALTER TABLE "kortix"."project_group_grants"
  ADD CONSTRAINT "project_group_grants_role_no_manager"
  CHECK (role != 'manager');
