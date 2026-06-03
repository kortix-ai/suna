import { getSupabase } from '../../shared/supabase';
import { db } from '../../shared/db';
import {
  getCreditAccount,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';
import { InsufficientCreditsError } from '../../errors';
import { MINIMUM_CREDIT_FOR_RUN } from './tiers';
export { grantCredits } from './credit-grants';

export async function getCreditSummary(accountId: string) {
  const account = await getCreditAccount(accountId);
  if (!account) {
    return { total: 0, daily: 0, monthly: 0, extra: 0, canRun: false };
  }

  const daily = Number(account.dailyCreditsBalance) || 0;
  const monthly = Number(account.expiringCredits) || 0;
  const extra = Number(account.nonExpiringCredits) || 0;
  const total = Number(account.balance) || 0;

  return {
    total,
    daily,
    monthly,
    extra,
    canRun: total >= MINIMUM_CREDIT_FOR_RUN,
  };
}

type LedgerDebitType = 'usage' | 'compute_debit' | 'llm_debit' | 'token_deduction' | 'token_overage';

export async function deductCredits(
  accountId: string,
  amount: number,
  description: string,
  ledgerType: LedgerDebitType = 'usage',
) {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('atomic_use_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_description: description,
    p_ledger_type: ledgerType,
  });

  if (error) {
    console.error('[Credits] Deduction RPC error:', error);
    const account = await getCreditAccount(accountId);
    const actualBalance = account ? Number(account.balance) : 0;
    throw new InsufficientCreditsError(actualBalance, amount);
  }

  const result = data as {
    success: boolean;
    error?: string;
    amount_deducted?: number;
    new_total?: number;
    transaction_id?: string;
  };

  if (!result.success) {
    const account = await getCreditAccount(accountId);
    const actualBalance = account ? Number(account.balance) : 0;
    throw new InsufficientCreditsError(actualBalance, amount);
  }

  const { checkAndTriggerAutoTopup } = await import('./auto-topup');
  void checkAndTriggerAutoTopup(accountId);

  return {
    success: true,
    cost: result.amount_deducted ?? amount,
    newBalance: result.new_total ?? 0,
    transactionId: result.transaction_id,
  };
}

export async function deductForLlmUsage(opts: {
  accountId: string;
  costUsd: number;
  model: string;
  provider?: string;
  actorUserId?: string | null;
  usageEventId?: string | null;
  upstreamCostUsd?: number | null;
  markup?: number | null;
}) {
  if (opts.costUsd <= 0) return { success: true, cost: 0, newBalance: 0, transactionId: null };
  const description = `LLM · ${opts.provider ? `${opts.provider}/` : ''}${opts.model}`;
  const result = await deductCredits(opts.accountId, opts.costUsd, description, 'llm_debit');
  if (result.success && result.transactionId && (opts.usageEventId || opts.upstreamCostUsd != null)) {
    const { creditLedger } = await import('@kortix/db');
    const { eq, sql } = await import('drizzle-orm');
    const auditPatch: Record<string, unknown> = {};
    if (opts.usageEventId) auditPatch.usageEventId = opts.usageEventId;
    if (opts.upstreamCostUsd != null) auditPatch.upstreamCostUsd = opts.upstreamCostUsd;
    if (opts.markup != null) auditPatch.markup = opts.markup;
    if (opts.actorUserId) auditPatch.actorUserId = opts.actorUserId;
    auditPatch.route = '/v1/llm/chat/completions';
    await db
      .update(creditLedger)
      .set({
        metadata: sql`COALESCE(${creditLedger.metadata}, '{}'::jsonb) || ${JSON.stringify(auditPatch)}::jsonb`,
      })
      .where(eq(creditLedger.id, result.transactionId))
      .catch((err: unknown) => {
        console.warn('[Credits] failed to stamp ledger audit metadata:', err);
      });
  }
  return result;
}

export async function resetExpiringCredits(
  accountId: string,
  newCredits: number,
  description: string,
  stripeEventId?: string,
) {
  const supabase = getSupabase();

  const { error } = await supabase.rpc('atomic_reset_expiring_credits', {
    p_account_id: accountId,
    p_description: description,
    p_new_credits: newCredits,
    p_stripe_event_id: stripeEventId ?? null,
  });

  if (error) {
    console.error('[Credits] Reset expiring credits error, using drizzle fallback:', error);

    const account = await getCreditAccount(accountId);
    if (account) {
      const nonExpiring = Number(account.nonExpiringCredits) || 0;
      const daily = Number(account.dailyCreditsBalance) || 0;
      const newBalance = newCredits + nonExpiring + daily;

      await updateCreditAccount(accountId, {
        expiringCredits: String(newCredits),
        balance: String(newBalance),
      } as any);
    }

    try {
      await insertLedgerEntry({
        accountId,
        amount: String(newCredits),
        balanceAfter: String(newCredits + (Number(account?.nonExpiringCredits) || 0)),
        type: 'credit_reset',
        description,
        isExpiring: true,
        stripeEventId: stripeEventId ?? null,
      });
    } catch (ledgerErr) {
      const msg = ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr);
      if (!msg.includes('duplicate key')) {
        console.error('[Credits] Reset ledger entry failed:', ledgerErr);
      }
    }
  }
}
