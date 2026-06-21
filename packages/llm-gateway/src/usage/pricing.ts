interface PriceEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface CostBreakdown {
  upstreamCost: number;
  finalCost: number;
}

function priceFromTable(pricing: PriceEntry, usage: TokenUsage): number {
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion * 0.1;
  return (
    ((usage.promptTokens - usage.cachedTokens) / 1_000_000) * pricing.inputPerMillion +
    (usage.cachedTokens / 1_000_000) * cachedRate +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function calculateCost(
  _model: string,
  usage: TokenUsage,
  markup: number,
  upstreamCostHint?: number,
  pricingOverride?: PriceEntry,
): CostBreakdown {
  let upstreamCost: number;

  if (pricingOverride) {
    upstreamCost = priceFromTable(pricingOverride, usage);
  } else if (typeof upstreamCostHint === 'number' && upstreamCostHint > 0) {
    upstreamCost = upstreamCostHint;
  } else {
    upstreamCost = 0;
  }

  return { upstreamCost, finalCost: upstreamCost * (markup ?? 1) };
}
