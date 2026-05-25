-- SCIM 2.0 infrastructure. Adds an external_id column on account_members
-- (so the IdP can correlate its user records to ours) and a scim_tokens
-- table for long-lived bearer credentials used by Okta / Azure AD / etc.
--
-- Idempotent — every CREATE / ADD COLUMN guards with IF NOT EXISTS.

ALTER TABLE "kortix"."account_members"
  ADD COLUMN IF NOT EXISTS "scim_external_id" text;

-- One token row per credential the IdP holds. Plaintext is shown ONCE at
-- creation; we keep only a SHA-256 hash for validation.
CREATE TABLE IF NOT EXISTS "kortix"."scim_tokens" (
  "token_id"      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"    uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "name"          varchar(128) NOT NULL,
  "secret_hash"   text NOT NULL,
  "public_prefix" varchar(32) NOT NULL,
  "last_used_at"  timestamp with time zone,
  "created_by"    uuid,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at"    timestamp with time zone,
  "expires_at"    timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_scim_tokens_account"
  ON "kortix"."scim_tokens" ("account_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_scim_tokens_secret_hash"
  ON "kortix"."scim_tokens" ("secret_hash");

GRANT ALL ON TABLE "kortix"."scim_tokens" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kortix"."scim_tokens" TO authenticated;
