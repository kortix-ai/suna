-- Migration: connector_held_calls
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Additive: one new table that stores the encrypted input of a connector call
-- held for approval, so Approve runs it once, as the original caller.
-- Server-only (RLS on, no policy). Old API code never reads or writes it. The
-- partial index is on the new, empty table, so a plain CREATE INDEX is safe.

CREATE TABLE "kortix"."connector_held_calls" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"input_enc" text,
	"state" text NOT NULL,
	"dispatched_at" timestamp with time zone,
	"run_deadline" timestamp with time zone,
	"run_execution_id" uuid,
	"outcome" jsonb,
	"chat_decider" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "connector_held_calls_state_check" CHECK ("kortix"."connector_held_calls"."state" in ('held', 'queued', 'dispatched', 'ok', 'error', 'refused', 'unknown', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."connector_held_calls" ADD CONSTRAINT "connector_held_calls_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."connector_held_calls" ADD CONSTRAINT "connector_held_calls_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "kortix"."connector_calls"("execution_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connector_held_calls_run_due" ON "kortix"."connector_held_calls" USING btree ("state","run_deadline") WHERE "kortix"."connector_held_calls"."state" in ('queued', 'dispatched');--> statement-breakpoint
ALTER TABLE "kortix"."connector_held_calls" ENABLE ROW LEVEL SECURITY;
