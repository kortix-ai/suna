-- Migration: connector_call_status_expired_snapshot
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
-- mixed-version-safe: a no-op; the value already exists wherever the previous migration ran
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: IF NOT EXISTS; 20261020162514189_approval_expiry adds the value first on every env

-- Snapshot sync only. 20261020162514189_approval_expiry.sql added this value by
-- hand without updating the drizzle snapshot, so `Schema matches migrations`
-- regenerated it. IF NOT EXISTS makes this a no-op on every database that ran
-- that migration.
ALTER TYPE "kortix"."connector_call_status" ADD VALUE IF NOT EXISTS 'expired';