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

  // Precedence: a live upstream-reported cost (e.g. OpenRouter's usage.cost) is
  // the most accurate signal, so it wins. Only when the upstream reports nothing
  // (Bedrock/Claude, most native BYOK) do we fall back to the curated/live price
  // table — which is exactly the case the table exists to cover. The table is now
  // a FALLBACK, not an override; that's what lets curated managed pricing fix the
  // Bedrock $0 leak without overriding an accurate OpenRouter cost hint.
  if (typeof upstreamCostHint === 'number' && upstreamCostHint > 0) {
    upstreamCost = upstreamCostHint;
  } else if (pricingOverride) {
    upstreamCost = priceFromTable(pricingOverride, usage);
  } else {
    upstreamCost = 0;
  }

  return { upstreamCost, finalCost: upstreamCost * (markup ?? 1) };
}
