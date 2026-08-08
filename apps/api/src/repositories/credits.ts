import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { assertRpcDebitLedgerType } from '../billing/ledger-type-honesty';

interface CreditBalance {
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
async function getCreditBalance(accountId: string): Promise<CreditBalance | null> {
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
 * Granular kind stamped into credit_ledger.metadata->>'ledger_type'. Must stay
 * in sync with `LedgerDebitType` in billing/services/credits.ts — the usage
 * breakdown (billing/services/usage-breakdown.ts) classifies off this value.
 */
export type RouterLedgerDebitType = 'usage' | 'llm_debit' | 'compute_debit';

/**
 * Deduct credits atomically using database function.
 * Uses existing atomic_use_credits PostgreSQL function.
 * When billing is disabled (self-hosted), always succeeds.
 *
 * NAMED arguments, deliberately. This call used to pass THREE POSITIONAL args,
 * which silently bound the weaker of two overloads — SECURITY INVOKER, and it
 * stamped no `ledger_type`, so every router debit (web search, image search,
 * tool proxy, LLM reservation) was invisible to the usage breakdown and
 * reported as $0. Migration 20260730012238065 collapsed the two overloads into
 * one; naming the parameters here means this call site can never re-acquire an
 * arity-resolved binding if a future migration adds a signature back.
 */
export async function deductCredits(
  accountId: string,
  amount: number,
  description: string,
  ledgerType: RouterLedgerDebitType = 'usage',
): Promise<CreditDeductResult> {
  // The RPC hardcodes `type = 'usage'` on the ledger row, so a non-usage kind
  // here manufactures a row that contradicts itself. Checked BEFORE the
  // billing-disabled short circuit so a self-hosted run rejects the same
  // programming error a managed run does (2026-07-30 mislabelled-clawback
  // incident; see billing/ledger-type-honesty.ts).
  assertRpcDebitLedgerType(ledgerType);

  // Billing disabled: no deduction
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { success: true, amountDeducted: 0, newBalance: 0 };
  }

  try {
    const result = await db.execute(sql`SELECT atomic_use_credits(
      p_account_id => ${accountId}::uuid,
      p_amount => ${amount}::numeric,
      p_description => ${description}::text,
      p_ledger_type => ${ledgerType}::text
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
