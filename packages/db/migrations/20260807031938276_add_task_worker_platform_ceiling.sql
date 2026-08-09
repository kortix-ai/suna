-- Migration: add_task_worker_platform_ceiling
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

ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_contract_platform_ceiling" CHECK ("kortix"."project_tasks"."liveness_worker_contract" is null or (
        ("kortix"."project_tasks"."liveness_worker_contract"->>'max_wall_seconds')::numeric <= 3600
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_tokens')::numeric <= 1000000
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_cost_usd')::numeric <= 25
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_iterations')::numeric <= 128
      )) NOT VALID;
