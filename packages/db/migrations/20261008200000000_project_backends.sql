-- Migration: project_backends
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

-- Kortix Backends: one row per self-hosted Convex backend (one Platinum machine
-- each). The table is new and empty, so CREATE TABLE, its FK and its unique
-- index lock nothing that already holds rows.

CREATE TABLE "kortix"."project_backends" (
	"backend_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"status" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"provider" varchar(32) NOT NULL,
	"external_id" text,
	"url" text,
	"site_url" text,
	"admin_key_enc" text,
	"template" text,
	"cpu" integer NOT NULL,
	"memory_gb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "project_backends_status_check" CHECK ("kortix"."project_backends"."status" IN ('provisioning', 'running', 'error', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_backends" ADD CONSTRAINT "project_backends_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_backends_live_name_uniq" ON "kortix"."project_backends" USING btree ("project_id","name") WHERE "kortix"."project_backends"."deleted_at" IS NULL;