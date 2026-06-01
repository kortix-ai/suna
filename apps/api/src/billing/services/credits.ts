import { getSupabase } from '../../shared/supabase';
import { db } from '../../shared/db';
import {
  getCreditAccount,
  getCreditBalance,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';
import { InsufficientCreditsError } from '../../errors';
import { TOKEN_PRICE_MULTIPLIER, MINIMUM_CREDIT_FOR_RUN } from './tiers';

export async function getBalance(accountId: string) {
  const row = await getCreditBalance(accountId);
  if (!row) return { balance: 0, expiring: 0, nonExpiring: 0, daily: 0 };

  return {
    balance: Number(row.balance),
    expiring: Number(row.expiringCredits),
    nonExpiring: Number(row.nonExpiringCredits),
    daily: Number(row.dailyCreditsBalance),
  };
}

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

export type LedgerDebitType = 'usage' | 'compute_debit' | 'llm_debit' | 'token_deduction' | 'token_overage';

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

interface ModelPricing {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4.8': { inputPricePerMillion: 5, outputPricePerMillion: 25 },
  'claude-sonnet-4.6': { inputPricePerMillion: 3, outputPricePerMillion: 15 },
  'gpt-5.5': { inputPricePerMillion: 5, outputPricePerMillion: 30 },
  'gemini-3.5-flash': { inputPricePerMillion: 1.5, outputPricePerMillion: 9 },
  'gemini-3.1-pro': { inputPricePerMillion: 2, outputPricePerMillion: 12 },
  'deepseek-v4-flash': { inputPricePerMillion: 0.0983, outputPricePerMillion: 0.1966 },
  'deepseek-v4-pro': { inputPricePerMillion: 0.435, outputPricePerMillion: 0.87 },
  'minimax-m3': { inputPricePerMillion: 0.3, outputPricePerMillion: 1.2 },
  'kimi-k2.6': { inputPricePerMillion: 0.684, outputPricePerMillion: 3.42 },
  'glm-5.1': { inputPricePerMillion: 0.98, outputPricePerMillion: 3.08 },
  'grok-4.3': { inputPricePerMillion: 1.25, outputPricePerMillion: 2.5 },
};

function getModelPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || model.includes(key)) return pricing;
  }

  return { inputPricePerMillion: 2, outputPricePerMillion: 10 };
}

export function calculateTokenCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
): number {
  const pricing = getModelPricing(model);
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPricePerMillion;
  return (inputCost + outputCost) * TOKEN_PRICE_MULTIPLIER;
}

export async function grantCredits(
  accountId: string,
  amount: number,
  type: string,
  description: string,
  isExpiring: boolean = true,
  stripeEventId?: string,
) {
  const supabase = getSupabase();
  const idempotencyKey = stripeEventId ? `grant:${accountId}:${stripeEventId}` : null;

  const { data, error } = await supabase.rpc('atomic_add_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_is_expiring: isExpiring,
    p_description: description,
    p_expires_at: null,
    p_type: type,
    p_stripe_event_id: stripeEventId ?? null,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error('[Credits] Grant RPC error:', error);

    const account = await getCreditAccount(accountId);
    const currentBalance = account ? Number(account.balance) : 0;
    const newBalance = currentBalance + amount;

    try {
      await insertLedgerEntry({
        accountId,
        amount: String(amount),
        balanceAfter: String(newBalance),
        type,
        description,
        isExpiring,
        stripeEventId: stripeEventId ?? null,
        idempotencyKey,
      });
    } catch (insertErr) {
      const message = insertErr instanceof Error ? insertErr.message : String(insertErr);
      const isDuplicate =
        message.includes('duplicate key') &&
        (message.includes('kortix_unique_stripe_event') || message.includes('idx_kortix_credit_ledger_idempotency'));
      if (isDuplicate) {
        return { success: true, duplicate_prevented: true };
      }

      const missingIdempotencyColumn = message.includes('idempotency_key') && message.includes('does not exist');
      if (missingIdempotencyColumn) {
        await insertLedgerEntry({
          accountId,
          amount: String(amount),
          balanceAfter: String(newBalance),
          type,
          description,
          isExpiring,
          stripeEventId: stripeEventId ?? null,
        });
      } else {
        throw insertErr;
      }
    }

    if (isExpiring) {
      const currentExpiring = account ? Number(account.expiringCredits) : 0;
      await updateCreditAccount(accountId, {
        balance: String(newBalance),
        expiringCredits: String(currentExpiring + amount),
      } as any);
    } else {
      const currentNonExpiring = account ? Number(account.nonExpiringCredits) : 0;
      await updateCreditAccount(accountId, {
        balance: String(newBalance),
        nonExpiringCredits: String(currentNonExpiring + amount),
      } as any);
    }
  }

  return data;
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
