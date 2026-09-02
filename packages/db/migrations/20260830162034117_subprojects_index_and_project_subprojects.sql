-- Migration: subprojects_index_and_project_subprojects
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

CREATE TYPE "kortix"."subproject_source_kind" AS ENUM('github', 'upload');--> statement-breakpoint
CREATE TYPE "kortix"."subproject_status" AS ENUM('active', 'unavailable', 'yanked');--> statement-breakpoint
CREATE TYPE "kortix"."subproject_visibility" AS ENUM('public', 'account', 'private');--> statement-breakpoint
CREATE TABLE "kortix"."subprojects" (
	"subproject_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(128) NOT NULL,
	"source_kind" "kortix"."subproject_source_kind" DEFAULT 'github' NOT NULL,
	"repo_owner" varchar(255),
	"repo_name" varchar(255),
	"git_ref" varchar(255),
	"resolved_sha" varchar(64),
	"title" varchar(255) NOT NULL,
	"description" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upload_name" varchar(255),
	"stars" integer,
	"install_count" integer DEFAULT 0 NOT NULL,
	"visibility" "kortix"."subproject_visibility" DEFAULT 'account' NOT NULL,
	"account_id" uuid,
	"submitted_by" uuid,
	"status" "kortix"."subproject_status" DEFAULT 'active' NOT NULL,
	"last_crawled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_subprojects" (
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"subproject_id" uuid,
	"repo_owner" varchar(255) NOT NULL,
	"repo_name" varchar(255) NOT NULL,
	"git_ref" varchar(255),
	"resolved_sha" varchar(64),
	"title" varchar(255) NOT NULL,
	"install_session_id" text,
	"owns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_subprojects_project_id_slug_pk" PRIMARY KEY("project_id","slug")
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "subproject_slug" varchar(128);--> statement-breakpoint
ALTER TABLE "kortix"."subprojects" ADD CONSTRAINT "subprojects_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_subprojects" ADD CONSTRAINT "project_subprojects_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_subprojects" ADD CONSTRAINT "project_subprojects_subproject_id_subprojects_subproject_id_fk" FOREIGN KEY ("subproject_id") REFERENCES "kortix"."subprojects"("subproject_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_subprojects" ADD CONSTRAINT "project_subprojects_install_session_fk" FOREIGN KEY ("install_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subprojects_repo_ref" ON "kortix"."subprojects" USING btree ("repo_owner","repo_name",coalesce("git_ref", ''));--> statement-breakpoint
CREATE INDEX "idx_subprojects_listing" ON "kortix"."subprojects" USING btree ("visibility","status");--> statement-breakpoint
CREATE INDEX "idx_subprojects_account" ON "kortix"."subprojects" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_subprojects_slug" ON "kortix"."subprojects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_project_subprojects_subproject" ON "kortix"."project_subprojects" USING btree ("subproject_id");--> statement-breakpoint
CREATE INDEX "idx_project_subprojects_install_session" ON "kortix"."project_subprojects" USING btree ("install_session_id");