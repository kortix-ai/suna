-- Secrets are 100% project-scoped. Every vault item belongs to a project;
-- visibility is owner_user_id (only-me) + grants (select), else everyone. No
-- account- or user-global vault. Project secrets are re-derived from
-- kortix.project_secrets at boot. Idempotent: the drop only fires while a
-- pre-project-scoped shape exists (an owner_account_id or user_id column).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kortix' AND table_name = 'vault_items'
      AND column_name IN ('owner_account_id', 'user_id')
  ) THEN
    DROP TABLE IF EXISTS "kortix"."vault_item_grants" CASCADE;
    DROP TABLE IF EXISTS "kortix"."vault_items" CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."vault_items" (
  "item_id"       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id"    uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "kind"          "kortix"."vault_item_kind" DEFAULT 'env' NOT NULL,
  "name"          varchar(128) NOT NULL,
  "value_enc"     text NOT NULL,
  "owner_user_id" uuid,
  "provider_id"   varchar(64),
  "metadata"      jsonb DEFAULT '{}'::jsonb,
  "created_by"    uuid,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_vault_items_project"    ON "kortix"."vault_items" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_vault_items_owner_user" ON "kortix"."vault_items" ("owner_user_id");
-- A shared name is unique per project; a private name is unique per (project, member).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_vault_items_project_shared_name"
  ON "kortix"."vault_items" ("project_id", "name") WHERE "owner_user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_vault_items_project_private_name"
  ON "kortix"."vault_items" ("project_id", "owner_user_id", "name") WHERE "owner_user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "kortix"."vault_item_grants" (
  "item_id"    uuid NOT NULL REFERENCES "kortix"."vault_items"("item_id") ON DELETE cascade,
  "user_id"    uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("item_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "idx_vault_item_grants_user" ON "kortix"."vault_item_grants" ("user_id");

GRANT ALL ON TABLE "kortix"."vault_items", "kortix"."vault_item_grants" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."vault_items", "kortix"."vault_item_grants" TO authenticated;
