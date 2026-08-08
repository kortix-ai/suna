-- Migration: app_deployment_provenance_schema_sync
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

-- mixed-version-safe: These temporary checks exist only to install physical
-- NOT NULL flags without a table scan. Both old and new API builds already
-- require created_by and actor_type on every new deployment.

-- The prior migration validated app_deployments_created_by_not_null. PostgreSQL
-- uses that proof to avoid scanning app_deployments while holding this lock.
ALTER TABLE "kortix"."app_deployments"
  -- squawk-ignore adding-not-nullable-field
  ALTER COLUMN "created_by" SET NOT NULL;

-- The prior migration validated app_deployments_actor_type_not_null.
ALTER TABLE "kortix"."app_deployments"
  -- squawk-ignore adding-not-nullable-field
  ALTER COLUMN "actor_type" SET NOT NULL;

ALTER TABLE "kortix"."app_deployments"
  DROP CONSTRAINT IF EXISTS "app_deployments_created_by_not_null";
ALTER TABLE "kortix"."app_deployments"
  DROP CONSTRAINT IF EXISTS "app_deployments_actor_type_not_null";
