-- Migration: project_space_links_collected
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
-- Channel links collected from people's messages, and Pin/Unpin. Only pinned
-- links reach the agents (the thread notes file). Every column is additive and
-- has a default (or is nullable), so the old code keeps inserting rows.
--
-- kortix.project_space_links was created by 20261023090000003 on this same
-- unmerged branch, so it is empty in every shared environment. A local
-- database may hold a few rows from "Add link"; that is the only data the
-- dedupe below and the plain index builds touch.

-- Existing rows were all added with "Add link": they keep pinned = true and
-- source = 'manual' from the defaults.
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "pinned" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "pinned_by" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "share_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "last_shared_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- The table is empty in every shared environment (see above): the FK check
-- reads no rows, and the brief lock on project_sessions is bounded by lock_timeout.
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "kortix"."project_space_links" ADD CONSTRAINT "project_space_links_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A local database may hold the same URL twice in one channel ("Add link" had
-- no uniqueness). Keep the oldest row so the unique index below can build.
-- backfill-safe: kortix.project_space_links, empty in every shared environment (created on this unmerged branch); at most a few local "Add link" rows; nothing writes the table at scale yet.
DELETE FROM "kortix"."project_space_links" a
  USING "kortix"."project_space_links" b
  WHERE a.space_id = b.space_id AND a.url = b.url AND (a.created_at, a.link_id) > (b.created_at, b.link_id);--> statement-breakpoint
-- The table is empty (see above): the builds block no real writes.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "uniq_project_space_links_space_url" ON "kortix"."project_space_links" USING btree ("space_id","url");--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "idx_project_space_links_session" ON "kortix"."project_space_links" USING btree ("session_id");--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "kortix"."project_space_links" ADD CONSTRAINT "project_space_links_source_check" CHECK ("kortix"."project_space_links"."source" in ('manual', 'message'));
