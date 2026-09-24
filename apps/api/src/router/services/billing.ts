import { config, getToolCost } from '../../config';

import { creditGateExemptEnv } from './credit-gate-env';

import { InsufficientCreditsError } from '../../errors';
import { wallet, type LedgerDebitType } from '../../billing/wallet';
import type { BillingCheckResult, BillingDeductResult } from '../../types';

/** Check if account has sufficient credits. */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01,
  options?: { skipDevCheck?: boolean }
): Promise<BillingCheckResult> {
  // When billing is disabled (self-host/dev), all checks pass — no Stripe, no
  // real subscriptions, and gating on a $0 balance just stalls everything.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || creditGateExemptEnv()) {
    return { hasCredits: true, balance: 0, message: 'Credits check skipped (billing disabled)' };
  }

  const current = await wallet.balance(accountId).catch((err) => {
    console.error('checkCredits error:', err);
    return null;
  });
  if (!current) {
    return { hasCredits: false, balance: 0, message: 'No credit account found' };
  }
  if (current.balance < minimumRequired) {
    return {
      hasCredits: false,
      balance: current.balance,
      message: `Insufficient credits. Balance: $${current.balance.toFixed(4)}`,
    };
  }
  return { hasCredits: true, balance: current.balance, message: 'OK' };
}

/**
 * Admission debit for a router call. A refusal is a result, not a throw: the
 * routes turn `error` into their 402 message.
 */
async function debitForRouter(
  accountId: string,
  amount: number,
  description: string,
  kind: LedgerDebitType,
): Promise<{ ok: true; amount: number; balance: number; transactionId: string } | { ok: false; error: string }> {
  try {
    const result = await wallet.debit({ accountId, amount, description, kind, key: null });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) return { ok: false, error: err.reason };
    console.error('deductCredits error:', err);
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
    return { success: false, cost: 0, newBalance: 0, error: result.error };
  }

  console.info(`[BILLING] Deducted $${cost.toFixed(4)}. New balance: $${result.balance.toFixed(2)}`);

  return {
    success: true,
    cost: result.amount || cost,
    newBalance: result.balance || 0,
    transactionId: result.transactionId,
  };
}

/** Deduct credits for LLM usage. */
export async function deductLLMCredits(
  accountId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  calculatedCost: number,
  sessionId?: string
): Promise<BillingDeductResult> {
  if (calculatedCost <= 0) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  // Skip deduction when billing is disabled (see deductToolCredits for rationale).
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || creditGateExemptEnv()) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const baseDescription = `LLM: ${model} (${inputTokens}/${outputTokens} tokens)`;
  const description = sessionId ? `${baseDescription} [session:${sessionId}]` : baseDescription;

  console.info(`[BILLING] Deducting $${calculatedCost.toFixed(6)} for ${model} (direct DB)`);

  // 'llm_debit' so this spend lands in the usage breakdown's LLM bucket. It is
  // real LLM spend and was already charged; before migration 20260730012238065
  // it bound an overload that stamped no ledger_type, so the breakdown reported
  // $0 LLM for every router-path request.
  const result = await debitForRouter(accountId, calculatedCost, description, 'llm_debit');

  if (!result.ok) {
    return { success: false, cost: 0, newBalance: 0, error: result.error };
  }

  console.info(`[BILLING] Deducted $${calculatedCost.toFixed(6)}. New balance: $${result.balance.toFixed(2)}`);

  return {
    success: true,
    cost: result.amount || calculatedCost,
    newBalance: result.balance || 0,
    transactionId: result.transactionId,
  };
}
