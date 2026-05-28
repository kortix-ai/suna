DO $$ BEGIN
  CREATE TYPE "kortix"."scope_effect" AS ENUM ('grant', 'revoke');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."sandbox_member_scopes" (
    "sandbox_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "scope" text NOT NULL,
    "effect" "kortix"."scope_effect" NOT NULL,
    "granted_by" uuid,
    "granted_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "kortix"."sandbox_member_scopes"
    ADD CONSTRAINT "sandbox_member_scopes_sandbox_id_fk"
    FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_sandbox_member_scopes_unique"
  ON "kortix"."sandbox_member_scopes" ("sandbox_id", "user_id", "scope");

CREATE INDEX IF NOT EXISTS "idx_sandbox_member_scopes_lookup"
  ON "kortix"."sandbox_member_scopes" ("sandbox_id", "user_id");
