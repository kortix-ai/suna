import { config, getToolCost } from '../../config';
import {
  deductCredits as deductBillingCredits,
  getCreditSummary,
} from '../../billing/services/credits';
import type { BillingCheckResult, BillingDeductResult } from '../../types';

/**
 * Check if account has sufficient credits.
 *
 * Uses direct DB query via Drizzle. Requires DATABASE_URL to be configured.
 */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01
): Promise<BillingCheckResult> {
  // When billing is disabled (self-host/dev), all checks pass — no Stripe, no
  // real subscriptions, and gating on a $0 balance just stalls everything.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { hasCredits: true, balance: 0, message: 'Credits check skipped (billing disabled)' };
  }

  let result: Awaited<ReturnType<typeof getCreditSummary>>;
  try {
    result = await getCreditSummary(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credit check failed';
    return { hasCredits: false, balance: 0, message };
  }

  return {
    hasCredits: result.total >= minimumRequired,
    message: result.total >= minimumRequired
      ? 'OK'
      : `Insufficient credits. Balance: $${result.total.toFixed(4)}`,
    balance: result.total,
  };
}

/**
 * Deduct credits for a Kortix tool call.
 *
 * Uses direct DB atomic deduction via Drizzle. Requires DATABASE_URL to be configured.
 */
export async function deductToolCredits(
  accountId: string,
  toolName: string,
  resultCount: number = 0,
  description?: string,
  sessionId?: string
): Promise<BillingDeductResult> {
  const cost = getToolCost(toolName, resultCount);
  if (cost <= 0) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  // Skip deduction when billing is disabled (self-host/dev) — no Stripe, no
  // real subscriptions, billing on a $0 balance would just stall everything
  // with InsufficientCreditsError.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const baseDescription =
    description ||
    `Kortix ${toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}`;
  const deductDescription = sessionId ? `${baseDescription} [session:${sessionId}]` : baseDescription;

  let result: Awaited<ReturnType<typeof deductBillingCredits>>;
  try {
    result = await deductBillingCredits(accountId, cost, deductDescription);
  } catch (error) {
    return {
      success: false,
      cost: 0,
      newBalance: 0,
      error: error instanceof Error ? error.message : 'Deduction error',
    };
  }

  return {
    success: true,
    cost: result.cost || cost,
    newBalance: result.newBalance || 0,
    transactionId: result.transactionId,
  };
}

/**
 * Deduct credits for LLM usage.
 *
 * Uses direct DB atomic deduction via Drizzle. Requires DATABASE_URL to be configured.
 */
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
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const baseDescription = `LLM: ${model} (${inputTokens}/${outputTokens} tokens)`;
  const description = sessionId ? `${baseDescription} [session:${sessionId}]` : baseDescription;

  let result: Awaited<ReturnType<typeof deductBillingCredits>>;
  try {
    result = await deductBillingCredits(accountId, calculatedCost, description, 'llm_debit');
  } catch (error) {
    return {
      success: false,
      cost: 0,
      newBalance: 0,
      error: error instanceof Error ? error.message : 'Deduction error',
    };
  }

  return {
    success: true,
    cost: result.cost || calculatedCost,
    newBalance: result.newBalance || 0,
    transactionId: result.transactionId,
  };
}
