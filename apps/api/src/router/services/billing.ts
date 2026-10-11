import { debitAndCheckAutoTopup } from '../../billing/services/wallet-debits';
import { config, getToolCost } from '../../config';

import { creditGateExemptEnv } from './credit-gate-env';

import { InsufficientCreditsError, WalletUnavailableError } from '../../errors';
import type { LedgerDebitType } from '../../billing/wallet';
import type { BillingDeductResult } from '../../types';

/**
 * Admission debit for a router call. A refusal is a result, not a throw: the
 * routes turn `error` into their 402 message.
 */
async function debitForRouter(
  accountId: string,
  amount: number,
  description: string,
  kind: LedgerDebitType,
): Promise<{ ok: true; amount: number; balance: number; transactionId: string } | { ok: false; error: string; retryable?: boolean }> {
  try {
    const result = await debitAndCheckAutoTopup({ accountId, amount, description, kind, key: null });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) return { ok: false, error: err.reason };
    if (err instanceof WalletUnavailableError) return { ok: false, error: err.message, retryable: true };
    console.error('[BILLING] router debit failed:', err);
    return { ok: false, error: 'Deduction error' };
  }
}

/** Deduct credits for a Kortix tool call. */
export async function deductToolCredits(
  accountId: string,
  toolName: string,
  resultCount: number = 0,
  description?: string,
  sessionId?: string,
  options?: { skipDevCheck?: boolean }
): Promise<BillingDeductResult> {
  const cost = getToolCost(toolName, resultCount);
  if (cost <= 0) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  // Skip deduction when billing is disabled (self-host/dev) — no Stripe, no
  // real subscriptions, billing on a $0 balance would just stall everything
  // with InsufficientCreditsError.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || creditGateExemptEnv()) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const baseDescription =
    description ||
    `Kortix ${toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}`;
  const deductDescription = sessionId ? `${baseDescription} [session:${sessionId}]` : baseDescription;

  console.info(`[BILLING] Deducting $${cost.toFixed(4)} for ${toolName} (direct DB)`);

  // 'usage' — deliberately NOT compute_debit or llm_debit. Kortix tool calls
  // (web/image search, tool proxy) are neither, and usage-breakdown.ts has no
  // third bucket to put them in. This keeps their classification byte-identical
  // to what the pre-20260730012238065 overload produced; inventing a category
  // here would move customer-visible numbers as a side effect of a DDL fix.
  const result = await debitForRouter(accountId, cost, deductDescription, 'usage');

  if (!result.ok) {
    return { success: false, cost: 0, newBalance: 0, error: result.error, retryable: result.retryable };
  }

  console.info(`[BILLING] Deducted $${cost.toFixed(4)}. New balance: $${result.balance.toFixed(2)}`);

  return {
    success: true,
    cost: result.amount || cost,
    newBalance: result.balance || 0,
    transactionId: result.transactionId,
  };
}
