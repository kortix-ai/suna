CREATE TABLE "kortix"."audit_session_sequences" (
	"session_id" text PRIMARY KEY NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"last_integrity_hash" varchar(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."audit_webhook_deliveries" (
	"delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" DROP CONSTRAINT "audit_events_account_id_accounts_account_id_fk";
--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "opencode_session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "session_sequence" bigint;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "initiator_actor_type" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "initiator_actor_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "parent_event_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "delegation_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "authoritative_source" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "client_reported_source" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "phase" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "causation_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_ledger" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_record_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "input_summary" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "output_summary" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "input_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "output_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "integrity_previous_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "integrity_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "phase" varchar(24) DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."audit_webhook_deliveries" ADD CONSTRAINT "audit_delivery_webhook_fk" FOREIGN KEY ("webhook_id") REFERENCES "kortix"."audit_webhooks"("webhook_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."audit_webhook_deliveries" ADD CONSTRAINT "audit_delivery_event_fk" FOREIGN KEY ("event_id") REFERENCES "kortix"."audit_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_audit_webhook_delivery_event" ON "kortix"."audit_webhook_deliveries" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_audit_webhook_delivery_due" ON "kortix"."audit_webhook_deliveries" USING btree ("status","next_attempt_at","locked_until");--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_project_sequence" ON "kortix"."audit_events" USING btree ("account_id","project_id","session_sequence");--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_session_sequence" ON "kortix"."audit_events" USING btree ("account_id","session_id","session_sequence");--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_source_phase_time" ON "kortix"."audit_events" USING btree ("account_id","authoritative_source","phase","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_client_source_time" ON "kortix"."audit_events" USING btree ("account_id","client_reported_source","occurred_at") WHERE "kortix"."audit_events"."client_reported_source" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_audit_events_source_phase" ON "kortix"."audit_events" USING btree ("source_ledger","source_record_id","phase",coalesce("source_revision", '')) WHERE "kortix"."audit_events"."source_ledger" is not null and "kortix"."audit_events"."source_record_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_audit_events_action_pattern" ON "kortix"."audit_events" USING btree ("action" text_pattern_ops);