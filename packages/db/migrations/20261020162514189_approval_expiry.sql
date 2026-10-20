-- Migration: approval_expiry
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

-- Approval expiry. Additive only: a new enum value and two nullable columns
-- (no rewrite, no backfill). Rows written before this ships keep expires_at
-- NULL and never expire. The partial index on expires_at is built
-- CONCURRENTLY in 20261020162524287_approval_expiry_index.concurrent.ts.
-- Nothing in this file uses 'expired'. Each file runs in its own transaction
-- (migration-target.ts), so the value is committed before any code writes it.
-- enum-value-checked: a new value this migration adds; no environment is baselined past this file, and the migration DB suite applies it from an empty database.

ALTER TYPE "kortix"."connector_call_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "kortix"."connector_calls" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."connector_project_settings" ADD COLUMN "approval_ttl_seconds" integer;
