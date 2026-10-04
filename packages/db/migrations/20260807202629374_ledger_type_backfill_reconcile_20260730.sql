-- Migration: ledger_type_backfill_reconcile_20260730
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
-- Deliberately raised from the 30s template default. The predicate below reads
-- metadata->>'ledger_type', which no index covers, so this is a sequential scan
-- of kortix.credit_ledger. The scan itself blocks nothing: it takes ACCESS SHARE,
-- and the UPDATE takes ROW EXCLUSIVE plus row locks on the ~1,609 matched rows
-- only. Neither conflicts with ordinary INSERT/UPDATE traffic from the API, so a
-- long statement here costs wall-clock, not availability. lock_timeout stays at
-- 2s so the migration still fails fast if something is holding a table-level
-- lock (a concurrent DDL/VACUUM FULL) rather than queueing behind it.
set statement_timeout = '300s';

-- WHY
--
-- On 2026-07-30 a hand-run entitlement reconciliation wrote clawback rows into
-- kortix.credit_ledger with type = 'usage' while stamping
-- metadata->>'ledger_type' = 'admin_debit'. The row therefore says two different
-- things about the same money.
--
-- Consequences of leaving it:
--   1. A -$5,239.xx operator correction on one account renders as a $5.5k usage
--      spike. That is what it looked like during a fraud investigation.
--   2. Any aggregation that groups on credit_ledger.type -- the
--      /billing/transactions type filter (apps/api/src/billing/repositories/
--      transactions.ts getTransactions) and every ad-hoc revenue query -- counts
--      an admin correction as customer usage.
--
-- The usage breakdown (apps/api/src/billing/services/usage-breakdown.ts) already
-- resolves the kind as COALESCE(NULLIF(metadata->>'ledger_type',''), type), so it
-- classifies these rows correctly TODAY and will keep classifying them correctly
-- AFTER this backfill -- metadata is not touched, and the fallback arm now agrees
-- with the primary arm instead of contradicting it. This migration makes the two
-- columns tell the same story; it does not change what the breakdown reports.
--
-- 'admin_debit' is an already-live value of this text column, not a new one:
-- apps/api/src/admin/index.ts writes it directly via grantCredits(..., 'admin_debit',
-- ...), and usage-breakdown.ts lists it in OTHER_DEBIT_KINDS. credit_ledger.type
-- is `text`, not an enum, so there is no enum value to add and no
-- enum-value-checked annotation to make.
--
-- mixed-version-safe: no schema object is dropped, renamed, or retyped -- this is
-- a data-only relabel, so the mixed-version guard does not require an annotation.
-- Recording the reasoning anyway: an API pod of ANY version reading these rows
-- goes through usage-breakdown's COALESCE (metadata unchanged -> same answer) or
-- through getTransactions' optional `type` filter. The only behaviour change for
-- an old pod is that an explicit filter for type='usage' stops returning admin
-- corrections, which is the defect being fixed, not a regression.
--
-- ROW-COUNT EXPECTATION
--   prod, first run:  ~1,609 rows (the 2026-07-30 reconciliation batch)
--   prod, re-run:     0 rows (the predicate no longer matches -- see IDEMPOTENCE)
--   dev / staging / local / self-host: 0 rows (never took that reconciliation)
--
-- IDEMPOTENCE
-- The predicate is self-extinguishing: it selects on type = 'usage', and the
-- UPDATE sets type = 'admin_debit'. A second run matches nothing and is a no-op.
-- 0 affected rows is therefore a SUCCESS, not a signal that the migration failed.
--
-- BLAST-RADIUS CEILING
-- The predicate is intentionally unbounded in time -- a row whose type and
-- metadata disagree in this exact way is mislabelled whenever it was written, and
-- the 2026-07-30 batch is the only known population. The ceiling below exists so
-- that if the predicate ever matches a population we did not reason about, the
-- migration aborts the transaction instead of silently rewriting money rows.
-- 10,000 is ~6x the known batch: loose enough to absorb an under-counted incident,
-- tight enough to catch "this is matching normal traffic".

DO $$
DECLARE
  v_updated bigint;
BEGIN
  UPDATE kortix.credit_ledger
  SET type = 'admin_debit'
  WHERE type = 'usage'
    AND metadata ->> 'ledger_type' = 'admin_debit';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 10000 THEN
    RAISE EXCEPTION
      'ledger_type backfill matched % credit_ledger rows; expected <= 10000 (~1609 on prod). Aborting so nothing is rewritten -- re-verify the predicate before re-running.',
      v_updated;
  END IF;

  RAISE NOTICE
    'ledger_type backfill: relabelled % credit_ledger rows usage -> admin_debit (prod expectation ~1609; 0 on a re-run or in an environment that never took the 2026-07-30 reconciliation).',
    v_updated;
END;
$$;
