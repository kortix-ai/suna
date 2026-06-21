ALTER TABLE "kortix"."project_secrets"
  ADD COLUMN IF NOT EXISTS "owner_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;

ALTER TABLE "kortix"."project_secrets"
  DROP CONSTRAINT IF EXISTS "idx_project_secrets_project_name";

DROP INDEX IF EXISTS "kortix"."idx_project_secrets_project_name";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_secrets_project_name_shared"
  ON "kortix"."project_secrets" USING btree ("project_id", "name")
  WHERE "owner_user_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_secrets_project_name_owner"
  ON "kortix"."project_secrets" USING btree ("project_id", "name", "owner_user_id")
  WHERE "owner_user_id" IS NOT NULL;
