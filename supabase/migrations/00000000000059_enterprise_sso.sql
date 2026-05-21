-- Enterprise SSO: account verified domains and Supabase SAML/OIDC mappings.
-- Supabase owns the SAML/OIDC protocol exchange; Kortix owns account policy,
-- domain routing, enforcement flags, JIT defaults, and auditability.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'account_sso_protocol'
  ) THEN
    CREATE TYPE "kortix"."account_sso_protocol" AS ENUM ('saml', 'oidc');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'account_sso_connection_status'
  ) THEN
    CREATE TYPE "kortix"."account_sso_connection_status" AS ENUM ('active', 'disabled');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'account_verified_domain_status'
  ) THEN
    CREATE TYPE "kortix"."account_verified_domain_status" AS ENUM ('pending', 'verified');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."account_sso_connections" (
  "connection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "provider_id" text NOT NULL,
  "provider_name" varchar(255),
  "protocol" "kortix"."account_sso_protocol" DEFAULT 'saml' NOT NULL,
  "status" "kortix"."account_sso_connection_status" DEFAULT 'active' NOT NULL,
  "enforced" boolean DEFAULT false NOT NULL,
  "jit_provisioning_enabled" boolean DEFAULT true NOT NULL,
  "default_role" "kortix"."account_role" DEFAULT 'member' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_account_sso_connections_account"
  ON "kortix"."account_sso_connections" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_account_sso_connections_provider"
  ON "kortix"."account_sso_connections" ("provider_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_sso_connections_account_provider"
  ON "kortix"."account_sso_connections" ("account_id", "provider_id");

CREATE TABLE IF NOT EXISTS "kortix"."account_verified_domains" (
  "domain_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "domain" varchar(255) NOT NULL,
  "status" "kortix"."account_verified_domain_status" DEFAULT 'pending' NOT NULL,
  "verification_token" text NOT NULL,
  "verified_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_verified_domains_domain_lowercase"
    CHECK ("domain" = lower("domain") AND "domain" NOT LIKE '%@%' AND "domain" NOT LIKE '%/%')
);

CREATE INDEX IF NOT EXISTS "idx_account_verified_domains_account"
  ON "kortix"."account_verified_domains" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_account_verified_domains_domain"
  ON "kortix"."account_verified_domains" ("domain");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_verified_domains_lower_domain"
  ON "kortix"."account_verified_domains" (lower("domain"));

GRANT ALL ON TABLE
  "kortix"."account_sso_connections",
  "kortix"."account_verified_domains"
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "kortix"."account_sso_connections",
  "kortix"."account_verified_domains"
TO authenticated;
