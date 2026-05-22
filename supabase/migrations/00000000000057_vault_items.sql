-- Unified vault: account-owned secrets / credentials / (future) OAuth logins.
-- See docs/specs/unified-iam-vault-access.md. Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'vault_item_kind'
  ) THEN
    CREATE TYPE "kortix"."vault_item_kind" AS ENUM (
      'env', 'api_key', 'oauth_token', 'oauth_client', 'connection_secret'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."vault_items" (
  "item_id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "kind"             "kortix"."vault_item_kind" DEFAULT 'env' NOT NULL,
  "name"             varchar(128) NOT NULL,
  "value_enc"        text NOT NULL,
  "project_id"       uuid REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "owner_user_id"    uuid,
  "provider_id"      varchar(64),
  "metadata"         jsonb DEFAULT '{}'::jsonb,
  "created_by"       uuid,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_vault_items_account"    ON "kortix"."vault_items" ("owner_account_id");
CREATE INDEX IF NOT EXISTS "idx_vault_items_project"    ON "kortix"."vault_items" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_vault_items_owner_user" ON "kortix"."vault_items" ("owner_user_id");

-- A name is unique within a scope = (account, project, owner_user). COALESCE so
-- NULL project/owner collapse to a sentinel (NULLs would otherwise be distinct).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_vault_items_scope_name"
  ON "kortix"."vault_items" (
    "owner_account_id",
    COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("owner_user_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "name"
  );

CREATE TABLE IF NOT EXISTS "kortix"."vault_item_grants" (
  "item_id"    uuid NOT NULL REFERENCES "kortix"."vault_items"("item_id") ON DELETE cascade,
  "user_id"    uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("item_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "idx_vault_item_grants_user" ON "kortix"."vault_item_grants" ("user_id");

GRANT ALL ON TABLE "kortix"."vault_items", "kortix"."vault_item_grants" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."vault_items", "kortix"."vault_item_grants" TO authenticated;
