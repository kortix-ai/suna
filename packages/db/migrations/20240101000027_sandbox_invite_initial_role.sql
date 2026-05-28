ALTER TABLE "kortix"."sandbox_invites"
  ADD COLUMN IF NOT EXISTS "initial_role" "kortix"."account_role";

UPDATE "kortix"."sandbox_invites"
SET "initial_role" = 'member'
WHERE "initial_role" IS NULL;

ALTER TABLE "kortix"."sandbox_invites"
  ALTER COLUMN "initial_role" SET DEFAULT 'member';

ALTER TABLE "kortix"."sandbox_invites"
  ALTER COLUMN "initial_role" SET NOT NULL;
