-- Migration: monitor_events_and_boxes
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

CREATE TABLE "kortix"."project_monitor_boxes" (
	"box_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"external_id" text,
	"status" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"box_epoch" varchar(64) NOT NULL,
	"manifest_revision" text,
	"wake_lease_owner" text,
	"wake_lease_until" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "project_monitor_boxes_status_check" CHECK ("kortix"."project_monitor_boxes"."status" IN ('provisioning', 'starting', 'running', 'stopping', 'stopped', 'error', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_monitor_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"box_epoch" varchar(64) NOT NULL,
	"seq" bigint NOT NULL,
	"kind" varchar(16) NOT NULL,
	"line" jsonb NOT NULL,
	"emitted_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"session_id" text,
	"last_error" text,
	"fired_at" timestamp with time zone,
	CONSTRAINT "project_monitor_events_kind_check" CHECK ("kortix"."project_monitor_events"."kind" IN ('event', 'lifecycle')),
	CONSTRAINT "project_monitor_events_status_check" CHECK ("kortix"."project_monitor_events"."status" IN ('pending', 'fired', 'skipped', 'suppressed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "suppressed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "suppression_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "kortix"."project_monitor_boxes" ADD CONSTRAINT "project_monitor_boxes_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_monitor_events" ADD CONSTRAINT "project_monitor_events_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_monitor_boxes_external_idx" ON "kortix"."project_monitor_boxes" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_monitor_boxes_one_live_per_project" ON "kortix"."project_monitor_boxes" USING btree ("project_id") WHERE "kortix"."project_monitor_boxes"."status" IN ('provisioning', 'starting', 'running', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX "project_monitor_events_dedup_idx" ON "kortix"."project_monitor_events" USING btree ("project_id","slug","box_epoch","seq");--> statement-breakpoint
CREATE INDEX "project_monitor_events_drain_idx" ON "kortix"."project_monitor_events" USING btree ("status","ingested_at");--> statement-breakpoint
CREATE INDEX "project_monitor_events_monitor_idx" ON "kortix"."project_monitor_events" USING btree ("project_id","slug","ingested_at" DESC NULLS LAST);