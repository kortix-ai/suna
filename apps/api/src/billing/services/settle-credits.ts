/**
 * SETTLEMENT — recording work that has ALREADY been performed.
 *
 * Deliberately its OWN module, not a second export on `credits.ts`.
 *
 * Nine test files stub `billing/services/credits` with a partial
 * `mock.module` factory that lists the exports it needs. `mock.module`
 * replaces a module WHOLESALE, so adding an export there silently deletes it
 * for every one of them, and the failure surfaces as
 * `SyntaxError: Export named 'settleCredits' not found` attributed to NO test,
 * in whichever unrelated file happens to run next (2026-08-27 learning:
 * "A new import edge into a widely-mocked graph breaks hand-written module
 * mocks all over the suite"). The remedy that learning prescribes is to fix
 * the IMPORT, not the nine mocks — so settlement lives here, with `db` and
 * `supabase` as its entire dependency surface.
 *
 * The split is also the honest one, because these answer different questions:
 *
 *   deductCredits (credits.ts) — ADMISSION. "May this account start work?"
 *                                Strict floor, refuses below zero, throws.
 *   settleCredits (here)       — SETTLEMENT. "Record work already done."
 *                                Always records; may go negative.
 *
 * Refusing a settlement does not un-spend the money — it only deletes the
 * record of it. That is what silently froze `credit_ledger` on a drained
 * account while compute kept burning, and `credit_ledger` is what
 * "Spent this period" sums (usage-breakdown.ts).
 *
 * Overdraft is bounded by the admission floor and strictly SAFE: a negative
 * balance makes the next `deductCredits` refuse, so recording the debt blocks
 * the account HARDER than losing it did. It lands in the non-expiring bucket —
 * the account's own purchased credit — never in a grant.
 */
import { getSupabase } from '../../shared/supabase';
import { assertRpcDebitLedgerType } from '../ledger-type-honesty';
import type { LedgerDebitType } from './credits';

export async function settleCredits(
  accountId: string,
  amount: number,
  description: string,
  ledgerType: LedgerDebitType = 'usage',
  idempotencyKey?: string,
) {
  assertRpcDebitLedgerType(ledgerType);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('atomic_settle_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_description: description,
    p_ledger_type: ledgerType,
    ...(idempotencyKey ? { p_idempotency_key: idempotencyKey } : {}),
  });

  if (error) {
    console.error('[Credits] Settlement RPC error:', error);
    throw new Error(`Credit settlement failed for ${accountId}: ${error.message}`);
  }

  const result = data as {
    success: boolean;
    error?: string;
    amount_deducted?: number;
    new_total?: number;
    overdraft?: boolean;
    transaction_id?: string;
  };

  if (!result.success) {
    // Only reachable for a missing credit row or a non-positive amount — the
    // balance check that `deductCredits` applies does not exist here.
    throw new Error(`Credit settlement refused for ${accountId}: ${result.error ?? 'unknown'}`);
  }

  if (result.overdraft) {
    // Alertable: the account consumed more than it held. Bounded by the
    // admission floor, but the population is worth watching.
    console.warn(
      `[Credits] settlement overdraft account=${accountId} amount=${amount} balance=${result.new_total}`,
    );
  }

  const { checkAndTriggerAutoTopup } = await import('./auto-topup');
  void checkAndTriggerAutoTopup(accountId);

  return {
    success: true as const,
    cost: result.amount_deducted ?? amount,
    newBalance: result.new_total ?? 0,
    overdraft: result.overdraft ?? false,
    transactionId: result.transaction_id,
  };
}

