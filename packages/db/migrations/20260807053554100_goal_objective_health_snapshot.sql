-- Migration: goal_objective_health
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

CREATE TABLE "kortix"."project_goal_evaluations" (
	"evaluation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_slug" text NOT NULL,
	"trigger_slug" text NOT NULL,
	"source" varchar(16) NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" varchar(16) DEFAULT 'queued' NOT NULL,
	"lifecycle_command_id" uuid,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goal_evaluations_goal_slug_nonempty" CHECK (btrim("kortix"."project_goal_evaluations"."goal_slug") <> ''),
	CONSTRAINT "project_goal_evaluations_trigger_slug_nonempty" CHECK (btrim("kortix"."project_goal_evaluations"."trigger_slug") <> ''),
	CONSTRAINT "project_goal_evaluations_idempotency_nonempty" CHECK (btrim("kortix"."project_goal_evaluations"."idempotency_key") <> ''),
	CONSTRAINT "project_goal_evaluations_source_valid" CHECK ("kortix"."project_goal_evaluations"."source" in ('cron', 'manual')),
	CONSTRAINT "project_goal_evaluations_state_valid" CHECK ("kortix"."project_goal_evaluations"."state" in ('queued', 'fired', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_observations" ADD COLUMN "evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_evaluations" ADD CONSTRAINT "project_goal_evaluations_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_evaluations" ADD CONSTRAINT "project_goal_evaluations_session_fkey" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_evaluations"
  ADD CONSTRAINT "project_goal_evaluations_lifecycle_command_fkey"
  FOREIGN KEY ("lifecycle_command_id") REFERENCES "kortix"."session_lifecycle_commands"("command_id")
  ON DELETE SET NULL NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_goal_evaluations_idempotency" ON "kortix"."project_goal_evaluations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_project_goal_evaluations_goal_created" ON "kortix"."project_goal_evaluations" USING btree ("project_id","goal_slug","created_at");--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_observations"
  ADD CONSTRAINT "project_goal_observations_evaluation_fkey"
  FOREIGN KEY ("evaluation_id") REFERENCES "kortix"."project_goal_evaluations"("evaluation_id")
  ON DELETE NO ACTION NOT VALID;