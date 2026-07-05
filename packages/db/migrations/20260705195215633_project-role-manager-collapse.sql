-- Up Migration
--
-- Project-role collapse (Marko, 2026-07-05): 3 project roles → 2. `manager`
-- is retired; `editor` is now the top project role. The three actions that
-- used to be manager-only (project.delete, project.members.manage,
-- project.gateway.keys.manage) move to ACCOUNT owner/admin authority instead
-- — see apps/api/src/iam/role-perms.ts's ACCOUNT_ONLY_PROJECT_ACTIONS. No
-- project role (built-in or custom) carries them anymore.
--
-- Data: every existing `project_members.project_role = 'manager'` row becomes
-- `'editor'` (the project creator / a promoted member keeps full project-tier
-- access; their account-level authority, if any, is unaffected by this row).
-- Same for `project_group_grants.role`. `manager` bindings on custom
-- IAM v1 policies (`iam_policies` / `iam_role_actions`) are unaffected by this
-- migration: those tables store ACTION strings (e.g. "project.delete"), never
-- the literal role name "manager", so there is nothing to reconcile there —
-- the app-layer change (role-presets.ts) stops the three actions from being
-- delegable via a custom role going forward.
--
-- Enum disposition: Postgres cannot cleanly DROP a value from an existing enum
-- type (would require rebuilding the type + every column using it) — the same
-- constraint already documented for the retired `viewer` value on this enum.
-- We leave `manager` as an ORPHANED value in `kortix.project_role` — it still
-- exists as a possible enum literal, but nothing in the application writes it
-- anymore (normalizeProjectRole folds any incoming `manager` to `editor`
-- before it reaches the DB), and this migration guarantees no existing row
-- carries it. The CHECK constraints below are belt-and-suspenders: they make
-- `editor`/`member` the only values Postgres will accept for these two
-- columns going forward, independent of app-layer discipline.

UPDATE "kortix"."project_members"
SET project_role = 'editor', updated_at = now()
WHERE project_role = 'manager';

UPDATE "kortix"."project_group_grants"
SET role = 'editor', updated_at = now()
WHERE role = 'manager';

ALTER TABLE "kortix"."project_members"
  ADD CONSTRAINT "project_members_project_role_no_manager"
  CHECK (project_role != 'manager');

ALTER TABLE "kortix"."project_group_grants"
  ADD CONSTRAINT "project_group_grants_role_no_manager"
  CHECK (role != 'manager');

-- Down Migration
--
-- Reversible only in the narrow "undo the constraint" sense — which specific
-- rows were `manager` before this migration is not recoverable (deliberate,
-- safety-motivated collapse, matching the `viewer`/`user` precedent on this
-- same enum).
ALTER TABLE "kortix"."project_members"
  DROP CONSTRAINT IF EXISTS "project_members_project_role_no_manager";

ALTER TABLE "kortix"."project_group_grants"
  DROP CONSTRAINT IF EXISTS "project_group_grants_role_no_manager";
