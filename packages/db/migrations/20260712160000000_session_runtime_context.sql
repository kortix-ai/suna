-- Up Migration
--
-- Durable, non-secret, session-scoped context for wrapper backends. This is a
-- JSON envelope, not an env-var bag: the runtime receives it only as the single
-- server-owned KORTIX_SESSION_CONTEXT variable. Credentials and authorization
-- material intentionally do not belong in this table.

CREATE TABLE "kortix"."project_session_runtime_contexts" (
  "session_id" text PRIMARY KEY
    REFERENCES "kortix"."project_sessions"("session_id") ON DELETE CASCADE,
  "context" jsonb NOT NULL,
  "byte_size" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "project_session_runtime_contexts_byte_size_check"
    CHECK ("byte_size" >= 2 AND "byte_size" <= 16384),
  CONSTRAINT "project_session_runtime_contexts_object_check"
    CHECK (jsonb_typeof("context") = 'object')
);

CREATE INDEX "idx_project_session_runtime_contexts_updated"
  ON "kortix"."project_session_runtime_contexts" ("updated_at");

-- Down Migration

DROP TABLE IF EXISTS "kortix"."project_session_runtime_contexts";
