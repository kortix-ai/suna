-- Migration: acp_session_envelopes
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Durable, append-only log of raw inbound/outbound ACP JSON-RPC envelopes
-- (the ACP-first runtime's canonical transcript -- see the doc comment on
-- acpSessionEnvelopes in packages/db/src/schema/kortix.ts). Brand-new empty
-- table: the two FKs and the indexes are created against zero rows, so no
-- NOT VALID / CONCURRENTLY dance is needed -- they are all instant here.

CREATE TABLE "kortix"."acp_session_envelopes" (
	"ordinal" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"runtime_id" text NOT NULL,
	"direction" varchar(32) NOT NULL,
	"stream_event_id" bigint,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_session_envelopes_direction_check" CHECK ("kortix"."acp_session_envelopes"."direction" IN ('client_to_agent', 'agent_to_client'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."acp_session_envelopes" ADD CONSTRAINT "acp_session_envelopes_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."acp_session_envelopes" ADD CONSTRAINT "acp_session_envelopes_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_acp_session_envelopes_event_id" ON "kortix"."acp_session_envelopes" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_acp_session_envelopes_stream_event" ON "kortix"."acp_session_envelopes" USING btree ("session_id","direction","stream_event_id") WHERE "kortix"."acp_session_envelopes"."stream_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_acp_session_envelopes_session_ordinal" ON "kortix"."acp_session_envelopes" USING btree ("session_id","ordinal");