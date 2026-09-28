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
--   account_deletion_requests.scheduled_for: dev 15 rows / 1 NULL,
--     nullable; staging 497 rows / 0 NULL, nullable; prod 451 rows / 0
--     NULL, already NOT NULL.
--   sandboxes.is_included: dev 391 rows / 0 NULL, nullable; staging 0
--     rows, already NOT NULL; prod 532 rows / 0 NULL, already NOT NULL.
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
-- Each column is gated on its OWN current is_nullable in information_schema,
-- checked inside the same DO block that backfills and constrains it. Prod
-- (both columns already NOT NULL) and staging's sandboxes.is_included
-- (already NOT NULL) skip the UPDATE entirely -- not just the ALTER -- so an
-- already-converged environment never runs a scan against sandboxes (a
-- write-hot table) at all, only a catalog lookup. Where the guard does fire,
-- the tables are tiny (15-532 rows checked) so the backfill + SET NOT NULL
-- scan is sub-second; no `.concurrent.ts` is needed.
--
-- backfill-safe: bounded by the is_nullable guard plus `WHERE ... IS NULL`
-- -- currently 1 row (account_deletion_requests, dev only) and 0 rows
-- (sandboxes, nowhere checked needs it). account_deletion_requests takes one
-- insert per account-deletion request (a rare, user-initiated action); no
-- writer queues behind a sub-second lock on it. sandboxes only runs its
-- UPDATE where is_included is still nullable, which is 0 rows everywhere
-- checked already, and the guard skips the table entirely once converged.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kortix'
      AND table_name = 'account_deletion_requests'
      AND column_name = 'scheduled_for'
      AND is_nullable = 'YES'
  ) THEN
    UPDATE kortix.account_deletion_requests
    SET scheduled_for = COALESCE(deletion_scheduled_for, requested_at + interval '30 days')
    WHERE scheduled_for IS NULL;

    ALTER TABLE kortix.account_deletion_requests
      ALTER COLUMN scheduled_for SET NOT NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kortix'
      AND table_name = 'sandboxes'
      AND column_name = 'is_included'
      AND is_nullable = 'YES'
  ) THEN
    UPDATE kortix.sandboxes
    SET is_included = false
    WHERE is_included IS NULL;

    ALTER TABLE kortix.sandboxes
      ALTER COLUMN is_included SET NOT NULL;
  END IF;
END
$$;
