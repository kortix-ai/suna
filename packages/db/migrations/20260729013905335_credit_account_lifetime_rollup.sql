-- Migration: credit_account_lifetime_rollup
--
-- credit_accounts.lifetime_granted / lifetime_purchased / lifetime_used (and
-- their _precise twins) have been DEAD since the Python -> TS rewrite. The
-- original `add_credits` / `deduct_credits` functions maintained them; the
-- `atomic_*` family that replaced them never did, and no TypeScript path ever
-- has. Every account therefore reads 0.0000 across all six columns no matter how
-- much it has been granted, has purchased, or has spent — while credit_ledger
-- records all of it correctly. A denormalized rollup that exists and lies is
-- worse than no rollup at all, so this makes it true and keeps it true.
--
-- Design: the rollup is maintained by a trigger on credit_ledger, NOT by editing
-- the seven atomic_* credit functions. The ledger is the authoritative record of
-- every credit movement, so deriving the rollup from ledger INSERTs means every
-- writer — the atomic_* RPCs, the Drizzle fallback paths in
-- apps/api/src/billing/services/credits.ts, admin adjustments, one-off repair
-- scripts — is covered by construction, and no future writer can silently skip
-- it. One classification rule, in one place, used by both the trigger and the
-- recompute/backfill.
--
-- Classification is SIGN-DRIVEN with two small allowlists, so an unrecognised
-- future ledger type can never be silently dropped:
--   amount < 0                      -> spend            (adds to lifetime_used)
--   amount > 0, purchase-ish type   -> money paid       (lifetime_purchased)
--   amount > 0, refund-ish type     -> reverses a debit (SUBTRACTS from lifetime_used)
--   amount > 0, anything else       -> platform grant   (lifetime_granted)
--
-- Only the _precise columns are written; the existing
-- kortix.sync_credit_account_precision_columns BEFORE trigger mirrors them into
-- the legacy numeric(12,4) columns.

set lock_timeout = '2s';
-- Deliberately raised for the one-off backfill below: it aggregates the whole of
-- credit_ledger once and updates every credit_accounts row. lock_timeout stays
-- at 2s so this fails fast instead of queueing behind live billing writes.
set statement_timeout = '300s';

-- ── Classification (single source of truth) ─────────────────────────────────
CREATE OR REPLACE FUNCTION kortix.credit_ledger_lifetime_deltas(
  p_amount numeric,
  p_type text
)
RETURNS TABLE (granted numeric, purchased numeric, used numeric)
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT
    CASE
      WHEN p_amount > 0
       AND COALESCE(p_type, '') NOT IN ('purchase', 'credit_purchase')
       AND COALESCE(p_type, '') NOT IN (
         'refund', 'llm_reservation_refund', 'tool_reservation_refund', 'compute_refund'
       )
      THEN p_amount ELSE 0
    END,
    CASE
      WHEN p_amount > 0 AND COALESCE(p_type, '') IN ('purchase', 'credit_purchase')
      THEN p_amount ELSE 0
    END,
    CASE
      WHEN p_amount < 0 THEN -p_amount
      WHEN p_amount > 0 AND COALESCE(p_type, '') IN (
        'refund', 'llm_reservation_refund', 'tool_reservation_refund', 'compute_refund'
      ) THEN -p_amount
      ELSE 0
    END;
$$;

COMMENT ON FUNCTION kortix.credit_ledger_lifetime_deltas(numeric, text) IS
  'How one credit_ledger row moves credit_accounts.lifetime_{granted,purchased,used}. Used by both the maintenance trigger and kortix.recompute_credit_account_lifetime.';

-- ── Incremental maintenance ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION kortix.apply_credit_ledger_lifetime_rollup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  v_granted numeric(20, 10);
  v_purchased numeric(20, 10);
  v_used numeric(20, 10);
BEGIN
  SELECT d.granted, d.purchased, d.used
  INTO v_granted, v_purchased, v_used
  FROM kortix.credit_ledger_lifetime_deltas(NEW.amount_precise, NEW.type) AS d;

  IF v_granted = 0 AND v_purchased = 0 AND v_used = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE kortix.credit_accounts
  SET lifetime_granted_precise = lifetime_granted_precise + v_granted,
      lifetime_purchased_precise = lifetime_purchased_precise + v_purchased,
      lifetime_used_precise = lifetime_used_precise + v_used
  WHERE account_id = NEW.account_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS apply_credit_ledger_lifetime_rollup ON kortix.credit_ledger;
CREATE TRIGGER apply_credit_ledger_lifetime_rollup
AFTER INSERT ON kortix.credit_ledger
FOR EACH ROW
EXECUTE FUNCTION kortix.apply_credit_ledger_lifetime_rollup();

-- ── Recompute / repair (idempotent, ledger is authoritative) ────────────────
-- Re-derives the rollup from the full ledger. Call with an account_id to repair
-- one account, or with NULL to recompute every account. Safe to run at any time:
-- it SETs absolute values rather than incrementing, so it converges.
CREATE OR REPLACE FUNCTION kortix.recompute_credit_account_lifetime(
  p_account_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  v_rows bigint;
BEGIN
  WITH totals AS (
    SELECT
      l.account_id,
      COALESCE(SUM(d.granted), 0) AS granted,
      COALESCE(SUM(d.purchased), 0) AS purchased,
      COALESCE(SUM(d.used), 0) AS used
    FROM kortix.credit_ledger l
    CROSS JOIN LATERAL kortix.credit_ledger_lifetime_deltas(l.amount_precise, l.type) AS d
    WHERE p_account_id IS NULL OR l.account_id = p_account_id
    GROUP BY l.account_id
  )
  UPDATE kortix.credit_accounts a
  SET lifetime_granted_precise = COALESCE(t.granted, 0),
      lifetime_purchased_precise = COALESCE(t.purchased, 0),
      lifetime_used_precise = COALESCE(t.used, 0)
  FROM totals t
  WHERE a.account_id = t.account_id
    AND (
      a.lifetime_granted_precise IS DISTINCT FROM COALESCE(t.granted, 0)
      OR a.lifetime_purchased_precise IS DISTINCT FROM COALESCE(t.purchased, 0)
      OR a.lifetime_used_precise IS DISTINCT FROM COALESCE(t.used, 0)
    );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION kortix.recompute_credit_account_lifetime(uuid) IS
  'Re-derive credit_accounts lifetime_* from credit_ledger. Idempotent; the ledger is authoritative. Pass NULL to recompute every account.';

-- ── One-off backfill ────────────────────────────────────────────────────────
-- Every existing account currently reads 0 for all three figures. A ledger row
-- inserted by a transaction that overlaps this statement can be missed (the
-- trigger below only sees rows inserted after this migration commits, and this
-- aggregate uses the statement snapshot); rerun
-- `SELECT kortix.recompute_credit_account_lifetime(NULL);` to reconcile if that
-- matters. These are reporting figures, not balances — no money depends on them.
SELECT kortix.recompute_credit_account_lifetime(NULL);
