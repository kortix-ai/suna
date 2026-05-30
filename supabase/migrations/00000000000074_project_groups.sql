-- Project groups: bundle projects under one name so a single policy
-- covers the whole bundle. Extends iam_scope_type enum to allow
-- scope_type='project_group' on iam_policies; the engine resolves
-- "is target project in this group?" at match time.

-- ALTER TYPE ... ADD VALUE can't run inside a transaction block when
-- the value is used in the same statement; run with IF NOT EXISTS so
-- re-running this migration is safe.
ALTER TYPE "kortix"."iam_scope_type" ADD VALUE IF NOT EXISTS 'project_group';

CREATE TABLE IF NOT EXISTS "kortix"."project_groups" (
  "group_id"    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"  uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "name"        varchar(128) NOT NULL,
  "description" text,
  "created_by"  uuid,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_project_groups_account"
  ON "kortix"."project_groups" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_groups_account_name"
  ON "kortix"."project_groups" ("account_id", "name");

CREATE TABLE IF NOT EXISTS "kortix"."project_group_members" (
  "group_id"   uuid NOT NULL REFERENCES "kortix"."project_groups"("group_id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "added_at"   timestamptz NOT NULL DEFAULT now(),
  "added_by"   uuid,
  PRIMARY KEY ("group_id", "project_id")
);

CREATE INDEX IF NOT EXISTS "idx_project_group_members_project"
  ON "kortix"."project_group_members" ("project_id");
