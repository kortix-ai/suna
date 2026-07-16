-- Pinned trigger session strategy: the session a `session_mode = 'pinned'`
-- trigger loops. FK to project_sessions with ON DELETE SET NULL so deleting the
-- session auto-clears the pin (the next fire then degrades to reuse/fresh rather
-- than hard-failing on a dangling id). The portable source of truth is the
-- manifest `session_id`; this column mirrors it for the FK + observability.
ALTER TABLE "kortix"."project_trigger_runtime"
  ADD COLUMN "session_id" text;

ALTER TABLE "kortix"."project_trigger_runtime"
  ADD CONSTRAINT "project_trigger_runtime_session_id_fk"
  FOREIGN KEY ("session_id")
  REFERENCES "kortix"."project_sessions" ("session_id")
  ON DELETE SET NULL;
