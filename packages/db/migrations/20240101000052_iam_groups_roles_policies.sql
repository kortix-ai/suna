-- IAM: Cloudflare-style groups + roles + policies.
--
-- Layered on top of kortix.account_members. A user's effective permissions are
-- the union of: super-admin bypass, the legacy account_role bridge (handled in
-- the engine, not in SQL), direct policies on the member, and policies on any
-- group the member belongs to. Idempotent so it survives re-runs.

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'account_group_source'
  ) THEN
    CREATE TYPE "kortix"."account_group_source" AS ENUM ('manual', 'scim');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'iam_principal_type'
  ) THEN
    CREATE TYPE "kortix"."iam_principal_type" AS ENUM ('member', 'group', 'token');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'iam_scope_type'
  ) THEN
    CREATE TYPE "kortix"."iam_scope_type" AS ENUM (
      'account', 'project', 'sandbox', 'trigger', 'channel', 'member', 'group'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'iam_resource_type'
  ) THEN
    CREATE TYPE "kortix"."iam_resource_type" AS ENUM (
      'account', 'project', 'sandbox', 'trigger', 'channel', 'member', 'group'
    );
  END IF;
END $$;

-- ─── Super-admin column on account_members ─────────────────────────────────

ALTER TABLE "kortix"."account_members"
  ADD COLUMN IF NOT EXISTS "is_super_admin" boolean DEFAULT false NOT NULL;

-- Seed: every existing 'owner' becomes a super-admin so cut-over is no-op.
UPDATE "kortix"."account_members"
SET "is_super_admin" = true
WHERE "account_role" = 'owner' AND "is_super_admin" = false;

-- ─── account_groups ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kortix"."account_groups" (
  "group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "name" varchar(128) NOT NULL,
  "description" text,
  "source" "kortix"."account_group_source" DEFAULT 'manual' NOT NULL,
  "external_id" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_account_groups_account" ON "kortix"."account_groups" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_groups_account_name" ON "kortix"."account_groups" ("account_id", "name");

-- ─── account_group_members ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kortix"."account_group_members" (
  "group_id" uuid NOT NULL REFERENCES "kortix"."account_groups"("group_id") ON DELETE cascade,
  "user_id" uuid NOT NULL,
  "added_by" uuid,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "idx_account_group_members_user" ON "kortix"."account_group_members" ("user_id");

-- ─── iam_roles ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kortix"."iam_roles" (
  "role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "key" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  "description" text,
  "resource_type" "kortix"."iam_resource_type" NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_iam_roles_account" ON "kortix"."iam_roles" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_iam_roles_resource_type" ON "kortix"."iam_roles" ("resource_type");
-- System roles (account_id IS NULL) must have globally unique keys.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_roles_system_key"
  ON "kortix"."iam_roles" ("key") WHERE "account_id" IS NULL;
-- Per-account custom roles unique within the account.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_roles_account_key"
  ON "kortix"."iam_roles" ("account_id", "key") WHERE "account_id" IS NOT NULL;

-- ─── iam_role_permissions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kortix"."iam_role_permissions" (
  "role_id" uuid NOT NULL REFERENCES "kortix"."iam_roles"("role_id") ON DELETE cascade,
  "action" varchar(128) NOT NULL,
  PRIMARY KEY ("role_id", "action")
);

CREATE INDEX IF NOT EXISTS "idx_iam_role_permissions_action" ON "kortix"."iam_role_permissions" ("action");

-- ─── iam_policies ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kortix"."iam_policies" (
  "policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "principal_type" "kortix"."iam_principal_type" NOT NULL,
  "principal_id" uuid NOT NULL,
  "scope_type" "kortix"."iam_scope_type" NOT NULL,
  "scope_id" uuid,
  "role_id" uuid NOT NULL REFERENCES "kortix"."iam_roles"("role_id") ON DELETE restrict,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The Everything scope (scope_type='account') must have a NULL scope_id;
  -- specific resource scopes must have a non-NULL scope_id.
  CONSTRAINT "iam_policies_scope_id_consistency" CHECK (
    ("scope_type" = 'account' AND "scope_id" IS NULL) OR
    ("scope_type" <> 'account')
  )
);

CREATE INDEX IF NOT EXISTS "idx_iam_policies_account" ON "kortix"."iam_policies" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_iam_policies_principal"
  ON "kortix"."iam_policies" ("account_id", "principal_type", "principal_id");
CREATE INDEX IF NOT EXISTS "idx_iam_policies_scope"
  ON "kortix"."iam_policies" ("account_id", "scope_type", "scope_id");
CREATE INDEX IF NOT EXISTS "idx_iam_policies_role" ON "kortix"."iam_policies" ("role_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_policies_unique_with_scope"
  ON "kortix"."iam_policies" (
    "account_id", "principal_type", "principal_id", "scope_type", "scope_id", "role_id"
  ) WHERE "scope_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_policies_unique_no_scope"
  ON "kortix"."iam_policies" (
    "account_id", "principal_type", "principal_id", "scope_type", "role_id"
  ) WHERE "scope_id" IS NULL;

-- ─── GRANTs ────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE
  "kortix"."account_groups",
  "kortix"."account_group_members",
  "kortix"."iam_roles",
  "kortix"."iam_role_permissions",
  "kortix"."iam_policies"
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "kortix"."account_groups",
  "kortix"."account_group_members",
  "kortix"."iam_role_permissions",
  "kortix"."iam_policies"
TO authenticated;

GRANT SELECT ON TABLE
  "kortix"."iam_roles"
TO authenticated;

GRANT SELECT ON TABLE
  "kortix"."account_groups",
  "kortix"."iam_roles",
  "kortix"."iam_role_permissions"
TO anon;
