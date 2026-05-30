interface PriceEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

const FALLBACK_PRICING: Record<string, PriceEntry> = {
  'anthropic/claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'anthropic/claude-haiku-4-5': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'anthropic/claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'anthropic/claude-3.5-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'anthropic/claude-3.5-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai/o1': { inputPerMillion: 15, outputPerMillion: 60 },
  'openai/o1-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'openai/o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'google/gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'google/gemini-2.0-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'x-ai/grok-2': { inputPerMillion: 2, outputPerMillion: 10 },
  'deepseek/deepseek-r1': { inputPerMillion: 3, outputPerMillion: 8 },
  'deepseek/deepseek-v3': { inputPerMillion: 0.5, outputPerMillion: 1.5 },
};

const DEFAULT_PRICING: PriceEntry = { inputPerMillion: 2, outputPerMillion: 10 };

function getPricing(model: string): PriceEntry {
  if (FALLBACK_PRICING[model]) return FALLBACK_PRICING[model];
  for (const [key, pricing] of Object.entries(FALLBACK_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
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

export function calculateCost(
  model: string,
  usage: TokenUsage,
  markup: number,
  upstreamCostHint?: number,
): CostBreakdown {
  let upstreamCost: number;

  if (typeof upstreamCostHint === 'number' && upstreamCostHint > 0) {
    upstreamCost = upstreamCostHint;
  } else {
    const pricing = getPricing(model);
    const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion * 0.1;
    upstreamCost =
      ((usage.promptTokens - usage.cachedTokens) / 1_000_000) * pricing.inputPerMillion +
      (usage.cachedTokens / 1_000_000) * cachedRate +
      (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  }

  return { upstreamCost, finalCost: upstreamCost * (markup ?? 1) };
}
