-- Migration: align_fresh_schema_contract
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The production schema already enforces these constraints. The original
-- node-pg-migrate baseline omitted them, so an empty fresh project diverges
-- from packages/db/src/schema/kortix.ts. Apply the NOT NULL changes only while
-- the tables are empty. This avoids a blocking validation scan on any existing
-- environment. Production contains zero conflicting NULL values as of
-- 2026-07-25.
ALTER TABLE kortix.credit_accounts
  ALTER COLUMN auto_topup_enabled SET DEFAULT false,
  ALTER COLUMN auto_topup_threshold SET DEFAULT 5,
  ALTER COLUMN auto_topup_amount SET DEFAULT 20;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kortix.credit_accounts LIMIT 1) THEN
    ALTER TABLE kortix.credit_accounts
      ALTER COLUMN auto_topup_enabled SET NOT NULL,
      ALTER COLUMN auto_topup_threshold SET NOT NULL,
      ALTER COLUMN auto_topup_amount SET NOT NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kortix.sandboxes LIMIT 1) THEN
    ALTER TABLE kortix.sandboxes
      ALTER COLUMN is_included SET NOT NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kortix.account_deletion_requests LIMIT 1) THEN
    ALTER TABLE kortix.account_deletion_requests
      ALTER COLUMN scheduled_for SET NOT NULL;
  END IF;
END
$$;
