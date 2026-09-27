// A credit_ledger row must not say two different things about the same money.
//
// THE INCIDENT (2026-07-30). A hand-run entitlement reconciliation wrote 1,609
// clawback rows with `type = 'usage'` while stamping
// `metadata->>'ledger_type' = 'admin_debit'`. The row therefore claimed to be
// customer usage in one column and an operator correction in the other. A
// -$5,239 admin correction on one account rendered as a $5.5k usage spike during
// a fraud investigation, and every aggregation that groups on
// credit_ledger.type counted an admin correction as revenue-bearing usage.
// The repair is packages/db/migrations/20260807202629374_ledger_type_backfill_reconcile_20260730.sql.
//
// WHAT "HONEST" MEANS HERE. `type` and `metadata->>'ledger_type'` are NOT
// duplicates — `ledger_type` is deliberately the finer grain. The wallet's debit
// function writes `type = 'usage'` for every debit it makes and puts the
// granular kind ('llm_debit', 'compute_debit', ...) in metadata. Those rows are
// honest: the granular kind is a SUB-KIND of usage. What is dishonest is a
// granular kind that is not usage at all — 'admin_debit', 'refund',
// 'adjustment' — carried on a row typed 'usage'.
//
// WHERE IT IS ENFORCED. Only the debit path can manufacture that shape: it is
// the one write whose `type` the caller does not control. Every other wallet
// write (grant, reset, forfeit) takes its `type` from the caller and carries no
// caller metadata, so it cannot contradict itself.

import { BillingError } from '../errors';

/**
 * Granular kinds that are legitimately carried on a row typed 'usage'.
 *
 * Kept in sync with `LedgerDebitType` (billing/wallet) — the values that reach
 * `kortix_wallet.debit_credits`, which hardcodes `type = 'usage'`.
 */
const USAGE_FAMILY_LEDGER_TYPES: readonly string[] = [
  'usage',
  'llm_debit',
  'compute_debit',
  'token_deduction',
  'token_overage',
];

export class LedgerTypeMismatchError extends BillingError {
  constructor(message: string) {
    super(message, 500);
    this.name = 'LedgerTypeMismatchError';
  }
}

/**
 * Guard the debit path.
 *
 * `kortix_wallet.debit_credits` hardcodes `type = 'usage'` on the row it
 * inserts and copies its `p_ledger_type` argument into metadata verbatim.
 * Passing a non-usage kind through it therefore MANUFACTURES the 2026-07-30 row
 * shape — the caller cannot make that row honest, because it does not control
 * the type column. Reject at the boundary instead.
 */
export function assertRpcDebitLedgerType(ledgerType: string): void {
  if (!USAGE_FAMILY_LEDGER_TYPES.includes(ledgerType)) {
    throw new LedgerTypeMismatchError(
      `kortix_wallet.debit_credits writes type='usage' unconditionally, so ledgerType='${ledgerType}' ` +
        `would produce a row that calls itself usage in one column and '${ledgerType}' in ` +
        `another (the 2026-07-30 mislabelled-clawback incident). Non-usage kinds must be ` +
        `written through wallet.grant with their own type.`,
    );
  }
}
