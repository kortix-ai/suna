DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix'
      AND t.typname = 'project_session_visibility'
  ) THEN
    CREATE TYPE "kortix"."project_session_visibility" AS ENUM ('private', 'project', 'restricted');
  END IF;
END
$$;

ALTER TABLE "kortix"."project_sessions"
  ADD COLUMN IF NOT EXISTS "created_by" uuid,
  ADD COLUMN IF NOT EXISTS "visibility" "kortix"."project_session_visibility" DEFAULT 'private' NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_project_sessions_created_by"
  ON "kortix"."project_sessions" USING btree ("created_by");

CREATE TABLE IF NOT EXISTS "kortix"."project_session_grants" (
  "grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade,
  "principal_type" "kortix"."secret_grant_principal" NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_project_session_grants_session"
  ON "kortix"."project_session_grants" USING btree ("session_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_session_grants_unique"
  ON "kortix"."project_session_grants" USING btree ("session_id", "principal_type", "principal_id");
