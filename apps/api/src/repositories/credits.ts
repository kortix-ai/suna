import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';

export interface CreditBalance {
  balance: number;
  expiringCredits: number;
  nonExpiringCredits: number;
  dailyCreditsBalance: number;
}

export interface CreditCheckResult {
  hasCredits: boolean;
  balance: number;
  message: string;
}

export interface CreditDeductResult {
  success: boolean;
  amountDeducted?: number;
  newBalance?: number;
  transactionId?: string;
  error?: string;
}

/**
 * Get credit balance for an account.
 * Fast single query.
 */
export async function getCreditBalance(accountId: string): Promise<CreditBalance | null> {
  try {
    const [row] = await db
      .select({
        balance: creditAccounts.balance,
        expiringCredits: creditAccounts.expiringCredits,
        nonExpiringCredits: creditAccounts.nonExpiringCredits,
        dailyCreditsBalance: creditAccounts.dailyCreditsBalance,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      balance: Number(row.balance) || 0,
      expiringCredits: Number(row.expiringCredits) || 0,
      nonExpiringCredits: Number(row.nonExpiringCredits) || 0,
      dailyCreditsBalance: Number(row.dailyCreditsBalance) || 0,
    };
  } catch (err) {
    console.error('getCreditBalance error:', err);
    return null;
  }
}

/**
 * Check if account has sufficient credits.
 * When billing is disabled (self-hosted), credits are unlimited — always returns true.
 */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01
): Promise<CreditCheckResult> {
  // Billing disabled: no credit gating
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { hasCredits: true, balance: 0, message: 'OK' };
  }

  const balance = await getCreditBalance(accountId);

  if (!balance) {
    return {
      hasCredits: false,
      balance: 0,
      message: 'No credit account found',
    };
  }

  if (balance.balance < minimumRequired) {
    return {
      hasCredits: false,
      balance: balance.balance,
      message: `Insufficient credits. Balance: $${balance.balance.toFixed(4)}`,
    };
  }

  return {
    hasCredits: true,
    balance: balance.balance,
    message: 'OK',
  };
}

/**
 * Deduct credits atomically using database function.
 * Uses existing atomic_use_credits PostgreSQL function.
 * When billing is disabled (self-hosted), always succeeds.
 */
export async function deductCredits(
  accountId: string,
  amount: number,
  description: string,
): Promise<CreditDeductResult> {
  // Billing disabled: no deduction
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { success: true, amountDeducted: 0, newBalance: 0 };
  }

  try {
    const result = await db.execute(sql`SELECT atomic_use_credits(
      ${accountId}::uuid,
      ${amount}::numeric,
      ${description}::text
    ) as result`);

    const row = result[0] as Record<string, unknown> | undefined;
    const data = row?.result as {
      success: boolean;
      error?: string;
      amount_deducted?: number;
      new_total?: number;
      transaction_id?: string;
    } | undefined;

    if (!data || !data.success) {
      return {
        success: false,
        error: data?.error || 'Unknown error',
      };
    }

    const output = {
      success: true,
      amountDeducted: data.amount_deducted,
      newBalance: data.new_total,
      transactionId: data.transaction_id,
    };

    // Fire-and-forget: check if auto-topup should trigger after successful deduction.
    // This repository path backs router billing (LLM/tool proxy), so auto-topup must run here.
    const { checkAndTriggerAutoTopup } = await import('../billing/services/auto-topup');
    void checkAndTriggerAutoTopup(accountId);

    return output;
  } catch (err) {
    console.error('deductCredits error:', err);
    return { success: false, error: 'Deduction error' };
  }
}
