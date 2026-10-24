-- Migration: memory_thread_loads
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

-- Memory is Markdown files in Drive; the database keeps only "Used memory":
-- the files a thread's first turn was listed (one row per session, written
-- once). Replaces the unshipped memory_pages migrations of this branch.
-- A new, empty table: the FK validates no rows, and RLS on with no policy
-- (API-only) matches kortix.project_space_links.

CREATE TABLE "kortix"."memory_thread_loads" (
	"session_id" text PRIMARY KEY NOT NULL,
	"first_loaded_at" timestamp with time zone NOT NULL,
	"layers" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."memory_thread_loads" ADD CONSTRAINT "memory_thread_loads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_thread_loads" ENABLE ROW LEVEL SECURITY;
