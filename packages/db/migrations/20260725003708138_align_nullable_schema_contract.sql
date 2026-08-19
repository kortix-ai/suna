-- Migration: align_nullable_schema_contract
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The current Drizzle schema and production already allow NULL for both
-- columns. The node-pg-migrate baseline made them NOT NULL only on fresh
-- databases.
--
-- mixed-version-safe: All deployed readers already handle NULL. These changes
-- relax constraints and do not invalidate existing writes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'kortix.account_deletion_requests'::regclass
      AND attname = 'requested_at'
      AND NOT attisdropped
      AND attnotnull
  ) THEN
    ALTER TABLE kortix.account_deletion_requests
      ALTER COLUMN requested_at DROP NOT NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'kortix.change_requests'::regclass
      AND attname = 'metadata'
      AND NOT attisdropped
      AND attnotnull
  ) THEN
    ALTER TABLE kortix.change_requests
      ALTER COLUMN metadata DROP NOT NULL;
  END IF;
END
$$;
