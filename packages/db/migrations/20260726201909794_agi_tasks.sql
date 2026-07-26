-- Migration: agi_tasks
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Purely additive: one brand-new table plus its own indexes and constraints. No
-- existing object is dropped, renamed, or retyped, and no value is added to an
-- existing enum, so no mixed-version-safe / enum-value-checked annotation is
-- required. Old code never sees the table; the two FKs only add a referential
-- check to writes on the NEW table (projects/agi_tasks are the referenced side).
-- Indexes are created inline with the table, which needs no CONCURRENTLY: the
-- table has no rows and no traffic at creation time.
--
-- Status/priority/origin are text + CHECK rather than Postgres enums on purpose:
-- the `agi` surface is experimental and these vocabularies will move, and a CHECK
-- constraint can be dropped where an enum value can never be removed.
CREATE TABLE "kortix"."agi_tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"goal_slug" text,
	"project" text,
	"title" text NOT NULL,
	"body" text,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"agent" text,
	"assignee_user_id" uuid,
	"blocked_by" uuid[] DEFAULT '{}' NOT NULL,
	"trigger_slug" text,
	"claim_session_id" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"origin" text NOT NULL,
	"origin_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agi_tasks_status_check" CHECK ("kortix"."agi_tasks"."status" in ('backlog', 'todo', 'doing', 'blocked', 'review', 'done', 'cancelled')),
	CONSTRAINT "agi_tasks_priority_check" CHECK ("kortix"."agi_tasks"."priority" in ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "agi_tasks_origin_check" CHECK ("kortix"."agi_tasks"."origin" in ('human', 'agi', 'session', 'trigger')),
	CONSTRAINT "agi_tasks_single_assignee_check" CHECK ("kortix"."agi_tasks"."agent" is null or "kortix"."agi_tasks"."assignee_user_id" is null),
	CONSTRAINT "agi_tasks_claim_coherent_check" CHECK (("kortix"."agi_tasks"."claim_session_id" is null and "kortix"."agi_tasks"."claimed_at" is null and "kortix"."agi_tasks"."claim_expires_at" is null) or ("kortix"."agi_tasks"."claim_session_id" is not null and "kortix"."agi_tasks"."claimed_at" is not null and "kortix"."agi_tasks"."claim_expires_at" is not null)),
	CONSTRAINT "agi_tasks_parent_not_self_check" CHECK ("kortix"."agi_tasks"."parent_id" is distinct from "kortix"."agi_tasks"."task_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."agi_tasks" ADD CONSTRAINT "agi_tasks_workspace_id_projects_project_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."agi_tasks" ADD CONSTRAINT "agi_tasks_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "kortix"."agi_tasks"("task_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_workspace_open" ON "kortix"."agi_tasks" USING btree ("workspace_id","priority","created_at" DESC NULLS LAST) WHERE status not in ('done', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_goal_open" ON "kortix"."agi_tasks" USING btree ("workspace_id","goal_slug","created_at" DESC NULLS LAST) WHERE status not in ('done', 'cancelled') and goal_slug is not null;--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_claimable" ON "kortix"."agi_tasks" USING btree ("workspace_id","claim_expires_at") WHERE status not in ('done', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_parent" ON "kortix"."agi_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_agent" ON "kortix"."agi_tasks" USING btree ("workspace_id","agent") WHERE agent is not null;--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_assignee_user" ON "kortix"."agi_tasks" USING btree ("workspace_id","assignee_user_id") WHERE assignee_user_id is not null;--> statement-breakpoint
CREATE INDEX "idx_agi_tasks_blocked_by" ON "kortix"."agi_tasks" USING gin ("blocked_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agi_tasks_origin_fingerprint" ON "kortix"."agi_tasks" USING btree ("workspace_id","origin_fingerprint") WHERE origin_fingerprint is not null;