ALTER TABLE "kortix"."sandbox_invites"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

UPDATE "kortix"."sandbox_invites"
SET "expires_at" = "created_at" + interval '14 days'
WHERE "expires_at" IS NULL;

ALTER TABLE "kortix"."sandbox_invites"
  ALTER COLUMN "expires_at" SET DEFAULT now() + interval '14 days';

ALTER TABLE "kortix"."sandbox_invites"
  ALTER COLUMN "expires_at" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sandbox_invites_expires_at"
  ON "kortix"."sandbox_invites" ("expires_at");
