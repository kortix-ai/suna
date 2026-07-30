set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE "kortix"."acp_session_envelopes" (
  "ordinal" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "runtime_instance_id" text NOT NULL,
  "direction" varchar(32) NOT NULL,
  "upstream_event_id" bigint,
  "envelope" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "acp_session_envelopes_direction_check"
    CHECK ("direction" IN ('client_to_agent', 'agent_to_client')),
  CONSTRAINT "acp_session_envelopes_session_id_project_sessions_session_id_fk"
    FOREIGN KEY ("session_id")
    REFERENCES "kortix"."project_sessions"("session_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT "acp_session_envelopes_project_id_projects_project_id_fk"
    FOREIGN KEY ("project_id")
    REFERENCES "kortix"."projects"("project_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "idx_acp_session_envelopes_event_id"
  ON "kortix"."acp_session_envelopes" ("event_id");
CREATE UNIQUE INDEX "idx_acp_session_envelopes_upstream_event"
  ON "kortix"."acp_session_envelopes" (
    "session_id",
    "direction",
    "runtime_instance_id",
    "upstream_event_id"
  )
  WHERE "upstream_event_id" IS NOT NULL;
CREATE INDEX "idx_acp_session_envelopes_session_ordinal"
  ON "kortix"."acp_session_envelopes" ("session_id", "ordinal");
