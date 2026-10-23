-- Migration: artifacts — HTML pages people and agents publish in a project
-- (flag `artifacts`), and their immutable versions. Two new tables, server-only
-- (RLS on, no policy): the API reads and writes them.
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

CREATE TABLE "kortix"."artifact_versions" (
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"files" jsonb NOT NULL,
	"label" varchar(60),
	"created_by_user_id" uuid NOT NULL,
	"created_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifact_id_version_pk" PRIMARY KEY("artifact_id","version")
);
--> statement-breakpoint
CREATE TABLE "kortix"."artifacts" (
	"artifact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" varchar(16) DEFAULT 'page' NOT NULL,
	"icon" varchar(40),
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"shared_with_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"pinned_by_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_type_check" CHECK ("kortix"."artifacts"."type" in ('page', 'doc', 'slides', 'board', 'dashboard')),
	CONSTRAINT "artifacts_visibility_check" CHECK ("kortix"."artifacts"."visibility" in ('private', 'project', 'public'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifacts" ADD CONSTRAINT "artifacts_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifacts_project_updated" ON "kortix"."artifacts" USING btree ("project_id","updated_at");--> statement-breakpoint
ALTER TABLE "kortix"."artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_versions" ENABLE ROW LEVEL SECURITY;
