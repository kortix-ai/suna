-- Migration: goals
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

CREATE TABLE "kortix"."project_goal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"from_state" text,
	"to_state" text,
	"message" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	CONSTRAINT "project_goal_events_actor_kind_check" CHECK ("kortix"."project_goal_events"."actor_kind" in ('user', 'session', 'platform'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."project_goals" (
	"goal_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"waiting_on" text,
	"chase_at" timestamp with time zone,
	"summary" text DEFAULT '' NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"stopped_at" timestamp with time zone,
	"stopped_by_user_id" uuid,
	"blocked_reason" text,
	"assigned_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"agent" text,
	"space" text,
	"drive_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"box_folder" text NOT NULL,
	"slug" text NOT NULL,
	"owner_session_id" text,
	"verifier_session_id" text,
	"sessions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria_revision" integer DEFAULT 0 NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification" jsonb,
	"verification_attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_reminder_id" text,
	"heartbeat_every" text DEFAULT '4h' NOT NULL,
	"next_wake_at" timestamp with time zone,
	"last_wake_at" timestamp with time zone,
	"max_wakes_per_day" integer DEFAULT 12 NOT NULL,
	"wake_day" date,
	"wakes_today" integer DEFAULT 0 NOT NULL,
	"max_sessions" integer DEFAULT 10 NOT NULL,
	"setup" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goals_state_check" CHECK ("kortix"."project_goals"."state" in ('draft', 'active', 'waiting_on_user', 'verifying', 'done', 'stopped')),
	CONSTRAINT "project_goals_blocked_reason_check" CHECK ("kortix"."project_goals"."blocked_reason" is null or "kortix"."project_goals"."blocked_reason" in ('credits', 'wake_cap', 'session_cap', 'owner_lost', 'storage', 'flag_off', 'setup')),
	CONSTRAINT "project_goals_provenance_check" CHECK ("kortix"."project_goals"."provenance" in ('api', 'legacy_unverified'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."project_goal_events" ADD CONSTRAINT "project_goal_events_goal_id_project_goals_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "kortix"."project_goals"("goal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_goals" ADD CONSTRAINT "project_goals_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_goal_events_dedupe" ON "kortix"."project_goal_events" USING btree ("goal_id","dedupe_key") WHERE "kortix"."project_goal_events"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "idx_project_goal_events_goal_at" ON "kortix"."project_goal_events" USING btree ("goal_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_goals_folder" ON "kortix"."project_goals" USING btree ("project_id","drive_id","folder");--> statement-breakpoint
CREATE INDEX "idx_project_goals_project_state" ON "kortix"."project_goals" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "idx_project_goals_owner_session" ON "kortix"."project_goals" USING btree ("owner_session_id");--> statement-breakpoint
CREATE INDEX "idx_project_goals_verifier_session" ON "kortix"."project_goals" USING btree ("verifier_session_id");--> statement-breakpoint
CREATE INDEX "idx_project_goals_heartbeat" ON "kortix"."project_goals" USING btree ("heartbeat_reminder_id");