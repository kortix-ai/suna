-- Up Migration
--
-- Fold the deprecated `viewer` project role into `user`. `user` (read + run
-- sessions + fire triggers) becomes the FLOOR project role; `viewer` is retired
-- from the UI and from all new assignments. Existing `viewer` rows are migrated
-- to `user`, and both project_role columns now default to `user`.
--
-- Note: former viewers gain `project.trigger.fire` (the one capability `user`
-- adds over the old `viewer` baseline) — this is the intended consolidation.
--
-- The `viewer` enum value is intentionally left in place — Postgres can't drop
-- an enum member, and nothing reads or writes it after this migration. The
-- value was added by 20260628140000000_project_role_user_tier.sql, so it is
-- already committed and safe to use here.

ALTER TABLE "kortix"."project_members"
  ALTER COLUMN "project_role" SET DEFAULT 'user';
UPDATE "kortix"."project_members"
  SET "project_role" = 'user'
  WHERE "project_role" = 'viewer';

ALTER TABLE "kortix"."project_group_grants"
  ALTER COLUMN "role" SET DEFAULT 'user';
UPDATE "kortix"."project_group_grants"
  SET "role" = 'user'
  WHERE "role" = 'viewer';

-- bootstrap_grants (account_invitations jsonb) may still carry 'viewer' in old,
-- not-yet-accepted invites. Those are read through parseProjectRole, which folds
-- 'viewer' -> 'user', so they need no rewrite here.

-- Down Migration
--
-- Forward-only: we can't tell which `user` rows were originally `viewer`, and
-- the distinction is gone by design. Restore only the prior column defaults.
ALTER TABLE "kortix"."project_members"
  ALTER COLUMN "project_role" SET DEFAULT 'viewer';
ALTER TABLE "kortix"."project_group_grants"
  ALTER COLUMN "role" SET DEFAULT 'viewer';
