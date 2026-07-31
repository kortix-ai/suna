-- Migration: credit_lifetime_fn_grants
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- 20260729013905335_credit_account_lifetime_rollup created three functions in
-- kortix without any GRANT EXECUTE. This database revokes the default PUBLIC
-- EXECUTE on functions, so the AFTER INSERT trigger on kortix.credit_ledger
-- fails with 42501 ("permission denied for function
-- credit_ledger_lifetime_deltas") whenever the inserting role is service_role
-- rather than a SECURITY DEFINER owner. Observed on staging and dev: every
-- non-SECURITY-DEFINER credit grant (e.g. the Stripe webhook grant path) has
-- failed since that migration deployed, caught by ke2e BILL-3/SESS-2 in the
-- v0.12.0 release gate. Grant EXECUTE the same way the atomic_* credit
-- functions do.

GRANT EXECUTE ON FUNCTION kortix.credit_ledger_lifetime_deltas(numeric, text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION kortix.apply_credit_ledger_lifetime_rollup() TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION kortix.recompute_credit_account_lifetime(uuid) TO service_role;
