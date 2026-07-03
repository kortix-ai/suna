-- Up Migration
--
-- Rename the floor project role `user` → `member`. "Member" reads better for a
-- person added to a project (and matches the account-level "member" vocabulary,
-- one axis down). This is a pure RENAME of the enum label: every existing
-- `user` row becomes `member` automatically — no row rewrite, position in the
-- enum preserved (manager, editor, member, viewer).
--
-- `user` (and the older `viewer`) live on ONLY as deprecated INPUT aliases in
-- code (parseProjectRole / normalizeProjectRole fold both → `member`), so old
-- clients, stored tokens, and not-yet-accepted invites keep working. Nothing
-- emits `user` or `viewer` after this. The dormant `viewer` enum value stays
-- (Postgres can't drop an enum member); `user` no longer exists as a label.
--
-- Scope: the `project_role` enum ONLY. The unrelated `account_role.member` and
-- `platform_role.user` values are a different axis and untouched.

ALTER TYPE "kortix"."project_role" RENAME VALUE 'user' TO 'member';

ALTER TABLE "kortix"."project_members"
  ALTER COLUMN "project_role" SET DEFAULT 'member';
ALTER TABLE "kortix"."project_group_grants"
  ALTER COLUMN "role" SET DEFAULT 'member';

-- bootstrap_grants (account_invitations jsonb) may still carry 'user'/'viewer'
-- in old, not-yet-accepted invites. Those are read through parseProjectRole,
-- which folds them → 'member', so they need no rewrite here.

-- Down Migration
--
-- Reversible: rename the label back, THEN restore the prior defaults (the
-- default must reference a label that exists, so the rename comes first). Rows
-- that were originally `user` are indistinguishable from any set to `member`
-- after the fact, but the label rename round-trips cleanly either way.
ALTER TYPE "kortix"."project_role" RENAME VALUE 'member' TO 'user';

ALTER TABLE "kortix"."project_members"
  ALTER COLUMN "project_role" SET DEFAULT 'user';
ALTER TABLE "kortix"."project_group_grants"
  ALTER COLUMN "role" SET DEFAULT 'user';
