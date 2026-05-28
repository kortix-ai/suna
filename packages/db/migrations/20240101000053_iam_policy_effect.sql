-- IAM deny policies. Adds an effect column ('allow' | 'deny') to iam_policies
-- so admins can carve out exceptions on top of broader allows. The engine
-- enforces: explicit deny wins over explicit allow, both win over the legacy
-- account_role / project_members bridges. Super-admin still bypasses.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'iam_policy_effect'
  ) THEN
    CREATE TYPE "kortix"."iam_policy_effect" AS ENUM ('allow', 'deny');
  END IF;
END $$;

ALTER TABLE "kortix"."iam_policies"
  ADD COLUMN IF NOT EXISTS "effect" "kortix"."iam_policy_effect" DEFAULT 'allow' NOT NULL;

-- The previous unique indexes excluded effect, which would block adding a
-- deny next to an existing allow for the same (principal, scope, role).
-- Drop and recreate with effect in the key.
DROP INDEX IF EXISTS "kortix"."idx_iam_policies_unique_with_scope";
DROP INDEX IF EXISTS "kortix"."idx_iam_policies_unique_no_scope";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_policies_unique_with_scope"
  ON "kortix"."iam_policies" (
    "account_id", "principal_type", "principal_id", "scope_type", "scope_id", "role_id", "effect"
  ) WHERE "scope_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_iam_policies_unique_no_scope"
  ON "kortix"."iam_policies" (
    "account_id", "principal_type", "principal_id", "scope_type", "role_id", "effect"
  ) WHERE "scope_id" IS NULL;
