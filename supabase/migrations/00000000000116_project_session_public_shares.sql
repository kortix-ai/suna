CREATE TABLE IF NOT EXISTS "kortix"."project_session_public_shares" (
  "share_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "session_id" text NOT NULL REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "created_by" uuid,
  "resource_type" text NOT NULL DEFAULT 'preview',
  "label" text NOT NULL DEFAULT 'App preview',
  "port" integer,
  "path" text NOT NULL DEFAULT '/',
  "file_path" text,
  "mode" text NOT NULL DEFAULT 'view',
  "allow_websocket" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_session_public_shares_token_hash"
  ON "kortix"."project_session_public_shares" USING btree ("token_hash");

CREATE INDEX IF NOT EXISTS "idx_project_session_public_shares_session"
  ON "kortix"."project_session_public_shares" USING btree ("session_id");

CREATE INDEX IF NOT EXISTS "idx_project_session_public_shares_project"
  ON "kortix"."project_session_public_shares" USING btree ("project_id");

ALTER TABLE "kortix"."project_session_public_shares"
  ADD COLUMN IF NOT EXISTS "resource_type" text NOT NULL DEFAULT 'preview';

ALTER TABLE "kortix"."project_session_public_shares"
  ADD COLUMN IF NOT EXISTS "file_path" text;

ALTER TABLE "kortix"."project_session_public_shares"
  ALTER COLUMN "port" DROP NOT NULL,
  ALTER COLUMN "label" SET DEFAULT 'App preview';
