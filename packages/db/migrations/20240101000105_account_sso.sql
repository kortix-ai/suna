-- SAML SSO per account. The Supabase auth.sso_providers row handles the
-- SAML handshake itself; this table records which kortix account owns
-- each provider plus the JWT claim that carries IdP group memberships.
--
-- On every JWT request we look up by supabase_sso_provider_id (or, for
-- the sign-in router, by primary_domain) to find the owning account and
-- sync membership + groups.

CREATE TABLE IF NOT EXISTS "kortix"."account_sso_providers" (
  "sso_provider_id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"               uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "supabase_sso_provider_id" uuid NOT NULL,
  "name"                     varchar(128) NOT NULL,
  "primary_domain"           varchar(253) NOT NULL,
  "group_claim_name"         varchar(128) NOT NULL DEFAULT 'groups',
  "auto_create_members"      boolean NOT NULL DEFAULT true,
  "created_by"               uuid,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_sso_providers_account"
  ON "kortix"."account_sso_providers" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_sso_providers_supabase"
  ON "kortix"."account_sso_providers" ("supabase_sso_provider_id");
CREATE INDEX IF NOT EXISTS "idx_account_sso_providers_domain"
  ON "kortix"."account_sso_providers" ("primary_domain");


CREATE TABLE IF NOT EXISTS "kortix"."account_sso_group_mappings" (
  "mapping_id"      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"      uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "sso_provider_id" uuid NOT NULL REFERENCES "kortix"."account_sso_providers"("sso_provider_id") ON DELETE CASCADE,
  "claim_value"     varchar(256) NOT NULL,
  "group_id"        uuid NOT NULL REFERENCES "kortix"."account_groups"("group_id") ON DELETE CASCADE,
  "created_by"      uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_sso_mappings_claim"
  ON "kortix"."account_sso_group_mappings" ("account_id", "claim_value");
CREATE INDEX IF NOT EXISTS "idx_account_sso_mappings_provider"
  ON "kortix"."account_sso_group_mappings" ("sso_provider_id");
CREATE INDEX IF NOT EXISTS "idx_account_sso_mappings_group"
  ON "kortix"."account_sso_group_mappings" ("group_id");
