-- Migration: enforce_credit_account_contract
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Production already marks these columns NOT NULL. A fresh database contains
-- one dogfood seed row before this migration, so the prior empty-table guard
-- cannot enforce the same contract there. Fail closed if any environment has a
-- conflicting row. Production and the us-west-2 target both had zero conflicts
-- on 2026-07-25.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM kortix.credit_accounts
    WHERE auto_topup_enabled IS NULL
       OR auto_topup_threshold IS NULL
       OR auto_topup_amount IS NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'credit_accounts contains NULL auto-topup settings';
  END IF;

  ALTER TABLE kortix.credit_accounts
    ALTER COLUMN auto_topup_enabled SET NOT NULL,
    ALTER COLUMN auto_topup_threshold SET NOT NULL,
    ALTER COLUMN auto_topup_amount SET NOT NULL;
END
$$;
