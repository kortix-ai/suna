-- Migration: apps_fly_model
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

CREATE TABLE "kortix"."app_volumes" (
	"volume_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(30) NOT NULL,
	"process_group" varchar(32) DEFAULT 'app' NOT NULL,
	"machine_id" uuid,
	"size_gb" integer NOT NULL,
	"provider" varchar(32) DEFAULT 'platinum' NOT NULL,
	"external_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'creating' NOT NULL,
	"attached_runtime_id" uuid,
	"snapshot_retention_days" integer DEFAULT 5 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "app_volumes_status_check" CHECK ("kortix"."app_volumes"."status" IN ('creating', 'ready', 'destroying', 'destroyed', 'error')),
	CONSTRAINT "app_volumes_size_check" CHECK ("kortix"."app_volumes"."size_gb" BETWEEN 1 AND 100),
	CONSTRAINT "app_volumes_retention_check" CHECK ("kortix"."app_volumes"."snapshot_retention_days" BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD COLUMN "strategy" varchar(16);--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD COLUMN "release_command_status" varchar(16);--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes" ADD COLUMN "process_group" varchar(32) DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes" ADD COLUMN "volume_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD COLUMN "scale" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."app_volumes" ADD CONSTRAINT "app_volumes_app_id_apps_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_volumes_app_idx" ON "kortix"."app_volumes" USING btree ("app_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "app_volumes_external_unique" ON "kortix"."app_volumes" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_volumes_machine_live_unique" ON "kortix"."app_volumes" USING btree ("machine_id") WHERE "kortix"."app_volumes"."deleted_at" IS NULL AND "kortix"."app_volumes"."machine_id" IS NOT NULL;