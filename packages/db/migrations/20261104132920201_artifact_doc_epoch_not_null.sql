-- Migration: artifact_doc_epoch_not_null
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

-- Every live doc state has an epoch (KRTX-3670 contract v3): a write naming
-- another epoch answers 409 epoch_mismatch, and a null epoch could never match.
-- The default first, so a seed from code that names no epoch still gets one.
ALTER TABLE "kortix"."artifact_doc_state" ALTER COLUMN "epoch" SET DEFAULT gen_random_uuid();--> statement-breakpoint
-- backfill-safe: kortix.artifact_doc_state is new in this release (20261104105157122_artifact_doc_sync, not yet on dev, staging or prod), holds one row per doc open for co-editing, and the GC job deletes idle rows; only rows seeded on a local or preview DB before 20261104124342923 have a null epoch (7 of 8 on this worktree's DB). The UPDATE touches those few rows; no writer can queue behind it for longer than that.
UPDATE "kortix"."artifact_doc_state" SET "epoch" = gen_random_uuid() WHERE "epoch" IS NULL;--> statement-breakpoint
-- mixed-version-safe: code without epochs (20261104105157122) inserts no epoch and gets the default above; code from 20261104124342923 on sets or reads it. SET NOT NULL scans this small table once under its lock (no NOT VALID CHECK needed: see the backfill-safe line).
ALTER TABLE "kortix"."artifact_doc_state"
  -- squawk-ignore adding-not-nullable-field
  ALTER COLUMN "epoch" SET NOT NULL;