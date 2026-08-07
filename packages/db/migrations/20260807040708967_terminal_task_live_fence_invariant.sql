-- Migration: terminal_task_live_fence_invariant
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

-- NOT VALID avoids a table scan while taking the schema lock. PostgreSQL still
-- enforces the invariant for every new or changed row after this statement.
ALTER TABLE "kortix"."project_tasks"
  ADD CONSTRAINT "project_tasks_terminal_has_no_live_fences"
  CHECK ("kortix"."project_tasks"."status" not in ('done', 'blocked') or num_nonnulls(
    "kortix"."project_tasks"."liveness_admission_id",
    "kortix"."project_tasks"."liveness_admission_expires_at",
    "kortix"."project_tasks"."git_write_request_id",
    "kortix"."project_tasks"."git_write_lease_expires_at"
  ) = 0) NOT VALID;

-- Mixed-version repair: old API replicas can already have committed terminal
-- tasks with a gateway admission fence. The task cannot become non-terminal,
-- so only the stale fence is removed. New writes are protected by the check.
UPDATE "kortix"."project_tasks"
SET "liveness_admission_id" = NULL,
    "liveness_admission_expires_at" = NULL,
    "git_write_request_id" = NULL,
    "git_write_lease_expires_at" = NULL
WHERE "status" IN ('done', 'blocked')
  AND num_nonnulls(
    "liveness_admission_id",
    "liveness_admission_expires_at",
    "git_write_request_id",
    "git_write_lease_expires_at"
  ) > 0;