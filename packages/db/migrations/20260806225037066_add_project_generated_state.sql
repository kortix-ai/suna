-- Migration: add_project_generated_state
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

CREATE TYPE "kortix"."project_task_status" AS ENUM('backlog', 'todo', 'doing', 'blocked', 'review', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "kortix"."project_goal_observations" (
	"observation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"source" text NOT NULL,
	"session_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goal_observations_goal_slug_nonempty" CHECK (btrim("kortix"."project_goal_observations"."goal_slug") <> ''),
	CONSTRAINT "project_goal_observations_metric_nonempty" CHECK (btrim("kortix"."project_goal_observations"."metric") <> ''),
	CONSTRAINT "project_goal_observations_source_nonempty" CHECK (btrim("kortix"."project_goal_observations"."source") <> ''),
	CONSTRAINT "project_goal_observations_value_finite" CHECK ("kortix"."project_goal_observations"."value" not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision))
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" "kortix"."project_task_status" DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_agent" text,
	"assignee_user_id" uuid,
	"blocked_by" uuid[] DEFAULT array[]::uuid[] NOT NULL,
	"origin" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_fingerprint" text,
	"claim_session_id" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tasks_project_task_unique" UNIQUE("project_id","task_id"),
	CONSTRAINT "project_tasks_goal_slug_nonempty" CHECK (btrim("kortix"."project_tasks"."goal_slug") <> ''),
	CONSTRAINT "project_tasks_title_nonempty" CHECK (btrim("kortix"."project_tasks"."title") <> ''),
	CONSTRAINT "project_tasks_origin_nonempty" CHECK (btrim("kortix"."project_tasks"."origin") <> ''),
	CONSTRAINT "project_tasks_origin_fingerprint_nonempty" CHECK ("kortix"."project_tasks"."origin_fingerprint" is null or btrim("kortix"."project_tasks"."origin_fingerprint") <> ''),
	CONSTRAINT "project_tasks_one_assignee" CHECK (num_nonnulls("kortix"."project_tasks"."assignee_agent", "kortix"."project_tasks"."assignee_user_id") <= 1),
	CONSTRAINT "project_tasks_assignee_agent_nonempty" CHECK ("kortix"."project_tasks"."assignee_agent" is null or btrim("kortix"."project_tasks"."assignee_agent") <> ''),
	CONSTRAINT "project_tasks_claim_complete" CHECK (num_nonnulls("kortix"."project_tasks"."claim_session_id", "kortix"."project_tasks"."claimed_at", "kortix"."project_tasks"."claim_expires_at") in (0, 3)),
	CONSTRAINT "project_tasks_claim_expiry_after_claim" CHECK ("kortix"."project_tasks"."claim_expires_at" is null or "kortix"."project_tasks"."claim_expires_at" > "kortix"."project_tasks"."claimed_at"),
	CONSTRAINT "project_tasks_not_self_blocked" CHECK (not ("kortix"."project_tasks"."task_id" = any("kortix"."project_tasks"."blocked_by")))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_observations" ADD CONSTRAINT "project_goal_observations_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_observations" ADD CONSTRAINT "project_goal_observations_session_fkey" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_claim_session_id_project_sessions_session_id_fk" FOREIGN KEY ("claim_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_project_parent_fkey" FOREIGN KEY ("project_id","parent_id") REFERENCES "kortix"."project_tasks"("project_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_goal_observations_range" ON "kortix"."project_goal_observations" USING btree ("project_id","goal_slug","metric","observed_at");--> statement-breakpoint
CREATE INDEX "idx_project_tasks_project_goal_status" ON "kortix"."project_tasks" USING btree ("project_id","goal_slug","status","priority");--> statement-breakpoint
CREATE INDEX "idx_project_tasks_project_parent" ON "kortix"."project_tasks" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_project_tasks_claim_expiry" ON "kortix"."project_tasks" USING btree ("claim_expires_at") WHERE "kortix"."project_tasks"."claim_session_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_project_tasks_blocked_by" ON "kortix"."project_tasks" USING gin ("blocked_by");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_tasks_project_origin_fingerprint" ON "kortix"."project_tasks" USING btree ("project_id","origin_fingerprint") WHERE "kortix"."project_tasks"."origin_fingerprint" is not null;