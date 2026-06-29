-- Up Migration
--
-- Add the "User (read + run)" project-role tier as a real, assignable value of
-- the project_role enum (project_members.project_role / project_group_grants.
-- role). It already existed as a clone-template preset but was unassignable
-- because the enum only had manager/editor/viewer. User = Viewer + fire-triggers
-- (read + run sessions + operate automations, no editing/config).
--
-- We RECREATE the type rather than `ALTER TYPE ... ADD VALUE` on purpose: the
-- migrate runner applies a batch in a single transaction (singleTransaction),
-- and a value added via ADD VALUE cannot be USED in the same transaction — but
-- a later migration (project_role_user_floor) writes 'user'. Values from
-- CREATE TYPE are usable immediately, so recreating sidesteps the "unsafe use
-- of new value" error on a fresh-DB apply. project_role is referenced only by
-- the two columns below (no functions / views / checks).

ALTER TYPE "kortix"."project_role" RENAME TO "project_role__pre_user";

CREATE TYPE "kortix"."project_role" AS ENUM ('manager', 'editor', 'user', 'viewer');

ALTER TABLE "kortix"."project_members"
  ALTER COLUMN "project_role" DROP DEFAULT,
  ALTER COLUMN "project_role" TYPE "kortix"."project_role"
    USING "project_role"::text::"kortix"."project_role",
  ALTER COLUMN "project_role" SET DEFAULT 'viewer';

ALTER TABLE "kortix"."project_group_grants"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" TYPE "kortix"."project_role"
    USING "role"::text::"kortix"."project_role",
  ALTER COLUMN "role" SET DEFAULT 'viewer';

DROP TYPE "kortix"."project_role__pre_user";

-- Down Migration
--
-- Forward-only: recreating the original (user-less) type would fail once any
-- row or default already uses 'user'.
SELECT 1;
