-- Migration: exact_trigger_scheduler
--
-- Adds nullable materialized schedule state to the existing runtime catalog
-- and creates a new durable execution queue. Existing API versions ignore the
-- new columns/table, while the new API tolerates uncataloged NULL rows.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE "kortix"."project_trigger_executions" (
	"execution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"schedule_revision" varchar(64) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"spec" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"session_id" text,
	"command_id" uuid,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "trigger_type" varchar(16);--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "enabled" boolean;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "schedule_cron" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "schedule_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "schedule_timezone" varchar(128);--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "schedule_revision" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "schedule_spec" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "next_fire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "last_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_executions" ADD CONSTRAINT "project_trigger_exec_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_executions" ADD CONSTRAINT "project_trigger_exec_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_trigger_executions_slot" ON "kortix"."project_trigger_executions" USING btree ("project_id","slug","schedule_revision","scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_project_trigger_executions_due" ON "kortix"."project_trigger_executions" USING btree ("status","available_at","locked_until");--> statement-breakpoint
CREATE INDEX "idx_project_trigger_executions_project" ON "kortix"."project_trigger_executions" USING btree ("project_id","created_at");
