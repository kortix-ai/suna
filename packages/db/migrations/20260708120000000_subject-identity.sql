-- Up Migration
--
-- Subject identity for "Kortix as a backend" (verticalized wrappers / untrusted
-- end-users). See docs/specs/2026-07-08-kortix-as-a-backend-subject-identity.md.
--
-- Additive and inert by default: the new columns default to NULL / FALSE, so every
-- existing token and code path is unchanged until backend mode is explicitly used.
--
--   subjects                     — external end-user identities an operator asserts
--   account_tokens.subject_id    — which subject a session token acts for
--   account_tokens.backend_scoped— TRUE = interact-only, single-session-enforced token

CREATE TABLE IF NOT EXISTS "kortix"."subjects" (
  "subject_id"   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"   uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "project_id"   uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "external_ref" varchar(255) NOT NULL,
  "display_name" varchar(255),
  "metadata"     jsonb DEFAULT '{}'::jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "disabled_at"  timestamptz
);
--> statement-breakpoint

-- One subject per (project, operator's external id) — lets the operator upsert
-- idempotently by their own end-user id.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subjects_project_external_ref"
  ON "kortix"."subjects" ("project_id", "external_ref");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_subjects_account"
  ON "kortix"."subjects" ("account_id");
--> statement-breakpoint

ALTER TABLE "kortix"."account_tokens"
  ADD COLUMN IF NOT EXISTS "subject_id" uuid
    REFERENCES "kortix"."subjects"("subject_id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "kortix"."account_tokens"
  ADD COLUMN IF NOT EXISTS "backend_scoped" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_account_tokens_subject"
  ON "kortix"."account_tokens" ("subject_id");
