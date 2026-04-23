CREATE TABLE IF NOT EXISTS "kortix"."sandbox_invites" (
    "invite_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "sandbox_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "email" varchar(255) NOT NULL,
    "invited_by" uuid,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "kortix"."sandbox_invites"
    ADD CONSTRAINT "sandbox_invites_sandbox_id_sandboxes_sandbox_id_fk"
    FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_sandbox_invites_email"
  ON "kortix"."sandbox_invites" (lower("email"));
CREATE INDEX IF NOT EXISTS "idx_sandbox_invites_sandbox"
  ON "kortix"."sandbox_invites" ("sandbox_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_sandbox_invites_pending_unique"
  ON "kortix"."sandbox_invites" ("sandbox_id", lower("email"))
  WHERE "accepted_at" IS NULL;
