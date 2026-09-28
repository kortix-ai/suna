-- Migration: converge_not_null_scheduled_for_is_included
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';
--
-- 20260725003240534_align_fresh_schema_contract.sql set these two columns
-- NOT NULL, but guarded each ALTER behind "only if the table is empty" to
-- avoid a blocking validation scan, "since production already enforces
-- these constraints". On dev and staging both tables already held rows on
-- 2026-07-25, so the guard skipped them there -- a real, known gap left
-- open by that migration's own design, not new drift. A fresh (empty)
-- database always takes the guarded branch, so kortix.ts's `.notNull()`
-- keeps holding on canonical and DB Drift Sentinel's dev job reports both
-- columns nullable-vs-canonical every night.
--
-- Read-only, 2026-09-28:
--   account_deletion_requests: dev 15 rows / 1 NULL scheduled_for,
--     staging 497 rows / 0 NULL, prod 451 rows / 0 NULL (prod: already
--     NOT NULL -- this statement is a no-op there).
--   sandboxes: dev 391 rows / 0 NULL is_included, staging 0 rows,
--     prod 532 rows / 0 NULL (prod: already NOT NULL, is_included is
--     already NOT NULL on staging too -- both no-ops there).
--   No row on any checked environment has scheduled_for AND
--   deletion_scheduled_for (the retired compatibility column,
--   20260718031324154_reconcile_account_deletion_legacy_column.sql) both
--   NULL.
--
-- The one dev row backfilled below is a pre-cutover leftover: its
-- deletion_scheduled_for (legacy column, requested_at + the grace period
-- that applied when it was written) is populated but scheduled_for -- the
-- column apps/api/src/billing/services/account-deletion.ts has written
-- exclusively since 20260718031324154 -- was never carried over for that
-- one row. Backfilling scheduled_for from deletion_scheduled_for completes
-- that legacy-to-canonical migration for it, rather than inventing a value.
-- The COALESCE fallback (requested_at + 30 days, the grace period recorded
-- on that same row) only guards an environment this change was not run
-- against, and is not expected to fire anywhere checked.
--
-- Table sizes (15-532 rows) make a full-table SET NOT NULL scan a
-- sub-second operation everywhere; no `.concurrent.ts` is needed.
--
-- backfill-safe: account_deletion_requests holds at most 532 rows on any
-- checked environment (dev/staging/prod) and the UPDATE below is bounded by
-- `WHERE scheduled_for IS NULL` (currently 1 row, on dev only) -- this is
-- the bounded, single-row-scale backfill the guard's escape hatch exists
-- for, not a hot-table rewrite; account_deletion_requests takes one insert
-- per account-deletion request (a rare, user-initiated action), so no
-- writer queues behind a sub-second lock on it.

UPDATE kortix.account_deletion_requests
SET scheduled_for = COALESCE(deletion_scheduled_for, requested_at + interval '30 days')
WHERE scheduled_for IS NULL;

DO $$
BEGIN
  ALTER TABLE kortix.account_deletion_requests
    ALTER COLUMN scheduled_for SET NOT NULL;
END
$$;

UPDATE kortix.sandboxes
SET is_included = false
WHERE is_included IS NULL;

DO $$
BEGIN
  ALTER TABLE kortix.sandboxes
    ALTER COLUMN is_included SET NOT NULL;
END
$$;
