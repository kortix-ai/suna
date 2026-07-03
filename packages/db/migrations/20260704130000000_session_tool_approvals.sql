-- Up Migration
--
-- Session-scoped "allow for this session" decisions for gated connector calls.
-- When a human approves a `require_approval` action AND picks "allow for the
-- rest of this session", we record (session, connector, action) here. The
-- executor gateway consults this table BEFORE holding a require_approval call:
-- a hit resolves the call to always-run for that session, so the same tool
-- never re-prompts. Rows are ephemeral (they matter only while the session is
-- alive); FKs cascade so a deleted project/connector cleans them up.
--
-- Only `require_approval` is session-allowable — a policy `block` is never
-- recorded here (the resolve endpoint refuses to approve a blocked call), so
-- this can only ever WIDEN from "ask" to "run", never override a hard block.

CREATE TABLE "kortix"."session_tool_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "connector_id" uuid NOT NULL REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE CASCADE,
  "action_path" varchar(512) NOT NULL,
  "granted_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_tool_approvals_unique" UNIQUE ("session_id", "connector_id", "action_path")
);

CREATE INDEX "session_tool_approvals_session_idx"
  ON "kortix"."session_tool_approvals" ("session_id");

-- Down Migration
DROP TABLE IF EXISTS "kortix"."session_tool_approvals";
