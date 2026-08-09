-- Migration: add_task_no_progress_settlement_ledger
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Safe deployment assumption:
-- project_tasks is created by 20260806225037066 and receives liveness columns
-- before this migration. The API deploy starts only after the complete migration
-- batch succeeds. Old API pods ignore this new table. The table is empty at
-- creation, so its inline constraints, foreign key, and plain index do not scan
-- or block writes to an existing relation. The task foreign key cascades cleanup.

CREATE TABLE "kortix"."project_task_no_progress_settlements" (
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"settlement_id" text NOT NULL,
	"claim_session_id" text NOT NULL,
	"worker_session_id" text NOT NULL,
	"action" text NOT NULL,
	"command_id" uuid NOT NULL,
	"task_snapshot" jsonb NOT NULL,
	"measured_usage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_no_progress_settlements_task_id_settlement_id_pk" PRIMARY KEY("task_id","settlement_id"),
	CONSTRAINT "project_task_no_progress_settlements_id_nonempty" CHECK (btrim("kortix"."project_task_no_progress_settlements"."settlement_id") <> ''),
	CONSTRAINT "project_task_no_progress_settlements_action_valid" CHECK ("kortix"."project_task_no_progress_settlements"."action" in ('continuation_queued', 'blocked_escalation_queued')),
	CONSTRAINT "project_task_no_progress_settlements_snapshots_objects" CHECK (jsonb_typeof("kortix"."project_task_no_progress_settlements"."task_snapshot") = 'object' and jsonb_typeof("kortix"."project_task_no_progress_settlements"."measured_usage") = 'object')
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_task_no_progress_settlements" ADD CONSTRAINT "project_task_no_progress_settlements_task_fkey" FOREIGN KEY ("project_id","task_id") REFERENCES "kortix"."project_tasks"("project_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_task_no_progress_settlements_project" ON "kortix"."project_task_no_progress_settlements" USING btree ("project_id");