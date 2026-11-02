-- Migration: storage_events_box_disk
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
--
-- Reviewed: kortix.storage_charges gains the volume.storage events of
-- GET /v1/billing/events (event_gib_hours, event_ids) and the box disk meter's
-- watermark (metered_through), and its kind check widens to worker_storage,
-- box_disk and box_disk_archived (storage-charges.ts, box-disk-charges.ts).
-- Three ADD COLUMNs with constant defaults: catalog-only, no rewrite. The new
-- CHECK is added NOT VALID: no scan. It still checks every insert and update,
-- and every existing row passed the narrower check it replaces, so it is never
-- validated.
-- mixed-version-safe: the check only widens (every value the old check allowed is still allowed), so old code still writes valid rows; old code never reads or writes the three new columns, and their defaults fill the rows it inserts.

ALTER TABLE "kortix"."storage_charges" DROP CONSTRAINT "storage_charges_kind";--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD COLUMN "event_gib_hours" numeric(24, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD COLUMN "event_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD COLUMN "metered_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD CONSTRAINT "storage_charges_kind" CHECK ("kortix"."storage_charges"."resource_kind" in ('volume', 'volume_snapshot', 'scratch', 'worker_storage', 'box_disk', 'box_disk_archived')) NOT VALID;