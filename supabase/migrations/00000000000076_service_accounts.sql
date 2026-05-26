-- Service accounts: first-class non-human IAM principals owned by the
-- account itself (not by a specific user). One bearer per SA; rotation
-- = disable + create new. Policies attach via principal_type='token'
-- with principal_id = service_account_id, reusing the existing IAM
-- engine token path.

CREATE TABLE IF NOT EXISTS "kortix"."service_accounts" (
  "service_account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"         uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "name"               varchar(128) NOT NULL,
  "description"        text,
  "secret_hash"        text NOT NULL,
  "public_prefix"      varchar(32) NOT NULL,
  "status"             varchar(16) NOT NULL DEFAULT 'active',
  "last_used_at"       timestamptz,
  "expires_at"         timestamptz,
  "created_by"         uuid,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "disabled_at"        timestamptz,
  "disabled_by"        uuid
);

CREATE INDEX IF NOT EXISTS "idx_service_accounts_account"
  ON "kortix"."service_accounts" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_service_accounts_secret_hash"
  ON "kortix"."service_accounts" ("secret_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_service_accounts_account_name"
  ON "kortix"."service_accounts" ("account_id", "name");
