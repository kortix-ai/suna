-- IAM V2: simplified access model.
--
-- One new table: project_group_grants. A row attaches an account_group
-- to a project with a chosen project_role. Every user in the group
-- inherits that role on that project. This is the "bulk-add" channel
-- and the destination for SCIM/SAML-pushed group memberships.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "kortix"."project_group_grants" (
  "project_id"  uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "group_id"    uuid NOT NULL REFERENCES "kortix"."account_groups"("group_id") ON DELETE CASCADE,
  "account_id"  uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "role"        "kortix"."project_role" NOT NULL DEFAULT 'viewer',
  "granted_by"  uuid,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "project_group_grants_pk" PRIMARY KEY ("project_id", "group_id")
);

CREATE INDEX IF NOT EXISTS "idx_project_group_grants_project"
  ON "kortix"."project_group_grants" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_group_grants_group"
  ON "kortix"."project_group_grants" ("group_id");
CREATE INDEX IF NOT EXISTS "idx_project_group_grants_account"
  ON "kortix"."project_group_grants" ("account_id");
