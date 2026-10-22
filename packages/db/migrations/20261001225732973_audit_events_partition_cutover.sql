-- Migration: audit_events_partition_cutover
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: the swap. In one transaction:
--     1. RENAME audit_events -> audit_events_legacy, and its indexes and primary key
--        to *_legacy_*;
--     2. RENAME audit_events_next -> audit_events, and its parent indexes to the final
--        names (partition-level indexes keep their generated names);
--     3. redefine the read view audit_events_all as audit_events UNION ALL
--        audit_events_legacy.
--   Locks, in order, all held to COMMIT:
--     RENAME TABLE / RENAME INDEX on the live table and its indexes: ACCESS EXCLUSIVE on
--       each renamed relation. The wait for the first one is bounded by lock_timeout 2 s
--       (it queues behind in-flight audit INSERTs, <= 10 s statement_timeout each, and
--       blocks the INSERTs that arrive after it). After the grant the whole transaction is
--       ~25 catalog updates, no table scan, no data movement: expected tens of ms.
--     RENAME on audit_events_next and its indexes: ACCESS EXCLUSIVE on an idle table.
--     CREATE OR REPLACE VIEW: ACCESS EXCLUSIVE on the view only.
--   On 55P03 the transaction rolls back completely (nothing renamed). Re-run the failed
--   job; never raise the timeout (learnings 2026-09-25, "Retry a hot-table ADD COLUMN").
--
-- WHY no 210 GB rewrite and no backfill: the old rows stay where they are, in
--   audit_events_legacy, and stay readable through audit_events_all. New rows go to the
--   partitioned table. The archive job (a later PR) exports legacy in weekly chunks as they
--   pass 90 days, then drops the whole legacy table when every row is older than 90 days.
--
-- Plans and sessions: renaming changes names, not OIDs, and bumps the relcache, so a
--   cached statement that named kortix.audit_events is re-analysed on its next execution
--   and resolves the new table (audit-events-partitioned.integration.test.ts proves it with
--   a prepared statement that ran before the swap). The view is rebuilt in this transaction
--   because it holds the OID of the table it was created over.
--
-- mixed-version-safe: both table names exist before and after this migration. Old code
--   INSERTs into kortix.audit_events and gets the new table (same columns, same defaults;
--   dedupe by the unique index with ON CONFLICT DO NOTHING, which every writer already
--   uses). Old code SELECTing FROM kortix.audit_events (the stage-2 build) sees only the new
--   rows until it is replaced; the stage-3 build reads audit_events_all and sees both. The
--   window is the rollout, minutes.
--
-- ROLL BACK: a forward migration that reverses the renames in one transaction (legacy back
--   to audit_events, the partitioned table back to audit_events_next) and redefines the
--   view. Rows written to the partitioned table in between would need an INSERT ... SELECT
--   into legacy first: bounded by the hours since the swap.
-- mixed-version-safe is stated in the header; the next rename re-creates the name.
-- squawk-ignore renaming-table
ALTER TABLE kortix.audit_events RENAME TO audit_events_legacy;--> statement-breakpoint

DO $$
DECLARE
  index_row record;
BEGIN
  FOR index_row IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'kortix' AND tablename = 'audit_events_legacy'
  LOOP
    EXECUTE format('ALTER INDEX kortix.%I RENAME TO %I',
      index_row.indexname,
      regexp_replace(index_row.indexname, 'audit_events', 'audit_events_legacy'));
  END LOOP;
END;
$$;--> statement-breakpoint

-- squawk-ignore renaming-table
ALTER TABLE kortix.audit_events_next RENAME TO audit_events;--> statement-breakpoint

DO $$
DECLARE
  index_row record;
BEGIN
  -- Parent indexes only: a partition's indexes are not in pg_indexes under the parent.
  FOR index_row IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'kortix' AND tablename = 'audit_events'
  LOOP
    EXECUTE format('ALTER INDEX kortix.%I RENAME TO %I',
      index_row.indexname,
      replace(index_row.indexname, 'audit_events_next', 'audit_events'));
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE VIEW kortix.audit_events_all AS
  SELECT * FROM kortix.audit_events
  UNION ALL
  SELECT * FROM kortix.audit_events_legacy;
