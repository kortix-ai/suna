import { getCreditAccount } from '../repositories/credit-accounts';
import { MINIMUM_CREDIT_FOR_RUN, TOKEN_PRICE_MULTIPLIER } from './tiers';
import { getManagedModel } from '@kortix/llm-catalog';
import { calculateCost as calculateGatewayCost } from '@kortix/llm-gateway';
import { requireModelPricing } from '../../router/config/models';

// Credit movements live in billing/wallet. This module derives a spendable
// summary from a credit row and prices tokens.

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
