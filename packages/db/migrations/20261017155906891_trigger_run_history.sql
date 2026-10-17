-- Migration: trigger_run_history
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

-- Run history (KRTX-1743): six additive columns on project_trigger_executions.
-- Every new column is nullable or has a constant default, so ADD COLUMN is a
-- catalog-only change (no rewrite) and old code that never names them keeps
-- working. The self-referencing replay_of FK is added NOT VALID: every
-- existing row has replay_of = null, and 20261017155906892 validates it.
-- The three run-history indexes are built CONCURRENTLY in the
-- 20261017155906893..895 .concurrent.ts files.

ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "source" varchar(16) DEFAULT 'cron' NOT NULL;
ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "replay_of" uuid;
ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "payload_verified" boolean DEFAULT true NOT NULL;
ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "run_status" varchar(16);
ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "run_error" text;
ALTER TABLE "kortix"."project_trigger_executions" ADD COLUMN "run_ended_at" timestamp with time zone;
ALTER TABLE "kortix"."project_trigger_executions" ADD CONSTRAINT "project_trigger_exec_replay_of_fk" FOREIGN KEY ("replay_of") REFERENCES "kortix"."project_trigger_executions"("execution_id") ON DELETE set null ON UPDATE no action NOT VALID;
