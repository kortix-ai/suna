-- Migration: project_spaces
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

-- Channels Phase 1: kortix.project_spaces holds channels and DMs; a thread is a
-- project_sessions row with space_id. space_id is a new nullable column, so
-- every existing row is null and satisfies the FK. The FK is added NOT VALID
-- (no scan under the ACCESS EXCLUSIVE lock); the next migration validates it.
-- idx_project_sessions_space is built CONCURRENTLY in its own migration.

CREATE TYPE "kortix"."project_space_kind" AS ENUM('channel', 'dm');--> statement-breakpoint
CREATE TABLE "kortix"."project_spaces" (
	"space_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "kortix"."project_space_kind" NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"dm_user_id" uuid,
	"dm_agent_name" text,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_spaces_kind_shape_check" CHECK (("kortix"."project_spaces"."kind" = 'channel' and "kortix"."project_spaces"."slug" is not null and "kortix"."project_spaces"."dm_user_id" is null and "kortix"."project_spaces"."dm_agent_name" is null) or ("kortix"."project_spaces"."kind" = 'dm' and "kortix"."project_spaces"."slug" is null and "kortix"."project_spaces"."dm_user_id" is not null and "kortix"."project_spaces"."dm_agent_name" is not null))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ADD CONSTRAINT "project_spaces_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ADD CONSTRAINT "project_spaces_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_channel_slug" ON "kortix"."project_spaces" USING btree ("project_id","slug") WHERE "kortix"."project_spaces"."kind" = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_dm" ON "kortix"."project_spaces" USING btree ("project_id","dm_user_id","dm_agent_name") WHERE "kortix"."project_spaces"."kind" = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_default" ON "kortix"."project_spaces" USING btree ("project_id") WHERE "kortix"."project_spaces"."is_default";--> statement-breakpoint
CREATE INDEX "idx_project_spaces_project" ON "kortix"."project_spaces" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD CONSTRAINT "project_sessions_space_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ENABLE ROW LEVEL SECURITY;
