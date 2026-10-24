-- Migration: project_trigger_runtime_space
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

-- Channels: a trigger posts its runs to a channel or DM as threads.
-- project_trigger_runtime.space_id is a new nullable column, so every existing
-- row is null and satisfies the FK. The FK is added NOT VALID (no scan under
-- the ACCESS EXCLUSIVE lock); 20261024105000006 validates it.
-- idx_project_trigger_runtime_space is built CONCURRENTLY in
-- 20261024105000005_project_trigger_runtime_space_index.concurrent.ts.

ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD CONSTRAINT "project_trigger_runtime_space_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE set null ON UPDATE no action NOT VALID;
