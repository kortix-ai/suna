-- Up Migration
--
-- "Allow all for this session" — a session-wide auto-approve grant. When a row
-- exists for a session, the executor gateway treats every require_approval
-- action in that session as always_run (no hold, no re-prompt) until the
-- session ends. Complements per-action session_tool_approvals: one blanket
-- grant vs one-action-at-a-time. One row per session (PK on session_id).

CREATE TABLE IF NOT EXISTS "kortix"."session_tool_allow_all" (
  "session_id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "granted_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "session_tool_allow_all_project_idx"
  ON "kortix"."session_tool_allow_all" ("project_id");
