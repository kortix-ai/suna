interface PriceEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

const FALLBACK_PRICING: Record<string, PriceEntry> = {
  'anthropic/claude-opus-4.8': { inputPerMillion: 5, outputPerMillion: 25 },
  'anthropic/claude-sonnet-4.6': { inputPerMillion: 3, outputPerMillion: 15 },
  'openai/gpt-5.5': { inputPerMillion: 5, outputPerMillion: 30 },
  'google/gemini-3.5-flash': { inputPerMillion: 1.5, outputPerMillion: 9 },
  'google/gemini-3.1-pro-preview': { inputPerMillion: 2, outputPerMillion: 12 },
  'deepseek/deepseek-v4-flash': { inputPerMillion: 0.0983, outputPerMillion: 0.1966 },
  'deepseek/deepseek-v4-pro': { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  'minimax/minimax-m3': { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  'moonshotai/kimi-k2.6': { inputPerMillion: 0.684, outputPerMillion: 3.42 },
  'z-ai/glm-5.1': { inputPerMillion: 0.98, outputPerMillion: 3.08 },
  'x-ai/grok-4.3': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
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
