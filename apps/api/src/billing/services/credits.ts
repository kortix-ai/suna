import { InsufficientCreditsError } from '../../errors';
import { db } from '../../shared/db';
import { getSupabase } from '../../shared/supabase';
import {
  getCreditAccount,
  getCreditBalance,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';
import { assertRpcDebitLedgerType } from '../ledger-type-honesty';
import { settleCredits } from './settle-credits';
import { MINIMUM_CREDIT_FOR_RUN, TOKEN_PRICE_MULTIPLIER } from './tiers';
import { getManagedModel } from '@kortix/llm-catalog';
import { calculateCost as calculateGatewayCost } from '@kortix/llm-gateway';
import { requireModelPricing } from '../../router/config/models';
import { isDuplicateCreditGrantError } from './credit-duplicate-error';

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

export async function getCreditSummary(
  accountId: string,
  prefetchedAccount?: Awaited<ReturnType<typeof getCreditAccount>>,
) {
  const account = prefetchedAccount !== undefined ? prefetchedAccount : await getCreditAccount(accountId);
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

export type LedgerDebitType =
  | 'usage'
  | 'compute_debit'
  | 'llm_debit'
  | 'token_deduction'
  | 'token_overage';

export async function deductCredits(
  accountId: string,
  amount: number,
  description: string,
  ledgerType: LedgerDebitType = 'usage',
  /**
   * Stable key identifying the thing being paid for.
   *
   * Without it, a debit whose RPC response is lost AFTER the function committed
   * is invisible to us: the wallet moved, this code believes it did not, and the
   * caller charges the same thing again. Commit-then-timeout is the ordinary
   * failure of a pooled RPC under load. Pass a key derived from WHAT is being
   * billed (not from the clock or a random id) so a retry produces the same one.
   */
  idempotencyKey?: string,
) {
  // The RPC hardcodes `type = 'usage'` on the ledger row, so a non-usage kind
  // here manufactures a row that contradicts itself. Reject before the money
  // moves rather than after (2026-07-30 mislabelled-clawback incident).
  assertRpcDebitLedgerType(ledgerType);

  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('atomic_use_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_description: description,
    p_ledger_type: ledgerType,
    ...(idempotencyKey ? { p_idempotency_key: idempotencyKey } : {}),
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
  // SETTLEMENT, not admission: these tokens are already generated and already
  // cost us money upstream. `deductCredits` would refuse this on a drained
  // wallet and the spend would simply disappear from the ledger — which is
  // exactly what happened for a full billing period.
  const result = await settleCredits(
    opts.accountId,
    opts.costUsd,
    description,
    'llm_debit',
    opts.usageEventId ? `llm:${opts.usageEventId}` : undefined,
  );
  if (
    result.success &&
    result.transactionId &&
    (opts.usageEventId || opts.upstreamCostUsd != null)
  ) {
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

export function calculateTokenCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
): number {
  const managed = getManagedModel(model);
  if (managed?.pricing) {
    return calculateGatewayCost(
      model,
      { promptTokens, completionTokens, cachedTokens: 0, cacheWriteTokens: 0 },
      TOKEN_PRICE_MULTIPLIER,
      undefined,
      managed.pricing,
    ).finalCost;
  }

  const pricingRef = managed?.pricingRef ?? model;
  const slash = pricingRef.indexOf('/');
  const providerId = slash > 0 ? pricingRef.slice(0, slash) : 'openrouter';
  const modelId = slash > 0 ? pricingRef.slice(slash + 1) : pricingRef;
  const pricing = requireModelPricing(modelId, providerId);
  return calculateGatewayCost(
    model,
    { promptTokens, completionTokens, cachedTokens: 0, cacheWriteTokens: 0 },
    TOKEN_PRICE_MULTIPLIER,
    undefined,
    {
      inputPerMillion: pricing.inputPer1M,
      outputPerMillion: pricing.outputPer1M,
      cachedInputPerMillion: pricing.cacheReadPer1M,
      cacheWritePerMillion: pricing.cacheWritePer1M,
      tiers: pricing.tiers?.map((tier) => ({
        inputPerMillion: tier.inputPer1M,
        outputPerMillion: tier.outputPer1M,
        cachedInputPerMillion: tier.cacheReadPer1M,
        cacheWritePerMillion: tier.cacheWritePer1M,
        contextThreshold: tier.contextThreshold,
      })),
      contextOver200k: pricing.contextOver200k
        ? {
            inputPerMillion: pricing.contextOver200k.inputPer1M,
            outputPerMillion: pricing.contextOver200k.outputPer1M,
            cachedInputPerMillion: pricing.contextOver200k.cacheReadPer1M,
            cacheWritePerMillion: pricing.contextOver200k.cacheWritePer1M,
            contextThreshold: pricing.contextOver200k.contextThreshold,
          }
        : undefined,
    },
  ).finalCost;
}

export async function grantCredits(
  accountId: string,
  amount: number,
  type: string,
  description: string,
  isExpiring = true,
  stripeEventId?: string,
  opts?: {
    /** Ledger expiry stamp for expiring grants (e.g. a trial's end date). */
    expiresAt?: string | null;
    /**
     * Explicit idempotency key. NOTE: the RPC only dedupes keys seen within
     * the last hour — callers that need long-window idempotency (monthly
     * re-grants) must check the ledger for the key themselves before calling.
     */
    idempotencyKey?: string | null;
  },
) {
  const supabase = getSupabase();
  const idempotencyKey =
    opts?.idempotencyKey ?? (stripeEventId ? `grant:${accountId}:${stripeEventId}` : null);

  const { data, error } = await supabase.rpc('atomic_add_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_is_expiring: isExpiring,
    p_description: description,
    p_expires_at: opts?.expiresAt ?? null,
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
      if (isDuplicateCreditGrantError(insertErr)) {
        return { success: true, duplicate_prevented: true };
      }

      const missingIdempotencyColumn =
        message.includes('idempotency_key') && message.includes('does not exist');
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
    // The same reset arriving twice is idempotent by design, and the RPC
    // refusing the second copy is not a fault — do not page for it, and do not
    // run the fallback, whose insert would collide on the same constraint and
    // whose account write would re-apply a grant that already landed.
    if (isDuplicateCreditGrantError(error)) {
      console.info('[Credits] Reset already applied; leaving the existing grant alone', {
        accountId,
        stripeEventId: stripeEventId ?? null,
      });
      return;
    }
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
      // A duplicate here is the idempotency key DOING ITS JOB: this reset was
      // already written, and `kortix_unique_stripe_event` refused the second
      // copy. It is a no-op, not a failure.
      //
      // The check used to be `ledgerErr.message.includes('duplicate key')`, and
      // a Drizzle error's `message` is only `Failed query: insert into
      // "kortix"."credit_ledger" … params: …` — the pg detail, the constraint
      // name and SQLSTATE 23505 all hang off `cause`. So the guard never
      // matched and every duplicate was logged as an error: PROD 2026-09-04 →
      // 2026-09-08, 1,118 of them for ONE free account (3049dd09), roughly one
      // every nine minutes, each one a correctly-refused re-grant of the same
      // `free_tier_rotation_…` event. `errorChainText` (used by
      // `isDuplicateCreditGrantError` a few lines up) already walks the chain.
      if (!isDuplicateCreditGrantError(ledgerErr)) {
        console.error('[Credits] Reset ledger entry failed:', ledgerErr);
      }
    }
  }
}
