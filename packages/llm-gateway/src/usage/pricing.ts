interface PriceEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  // Prompt-cache WRITE tokens (Anthropic `cache_creation_input_tokens`).
  // Already included in `promptTokens` (see domain/usage.ts) — optional and
  // defaulted to 0 here so every existing non-Anthropic call site (which never
  // had a concept of cache-write) keeps working unchanged.
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  upstreamCost: number;
  finalCost: number;
}

// Anthropic's published prompt-cache multipliers (docs.claude.com/en/docs/
// build-with-claude/prompt-caching, verified 2026-07): cache reads are 0.1x
// base input; cache writes are 1.25x base input for the default 5-minute TTL
// (2x for an explicit 1-hour TTL). This gateway never requests a 1-hour TTL
// (buildAnthropicRequest always sends a plain `cache_control: {type:
// "ephemeral"}` with no `ttl`), so 1.25x is the correct default fallback when
// a live per-model cache-write rate (models.dev `cost.cache_write`) isn't
// available.
const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

function priceFromTable(pricing: PriceEntry, usage: TokenUsage): number {
  const cachedTokens = usage.cachedTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cachedRate =
    pricing.cachedInputPerMillion ?? pricing.inputPerMillion * DEFAULT_CACHE_READ_MULTIPLIER;
  const cacheWriteRate =
    pricing.cacheWritePerMillion ?? pricing.inputPerMillion * DEFAULT_CACHE_WRITE_MULTIPLIER;
  // promptTokens already includes both cachedTokens and cacheWriteTokens (see
  // domain/usage.ts) — subtract both to get the plain-rate remainder. Guard
  // against a malformed/short upstream usage object driving this negative
  // (e.g. cachedTokens reported larger than promptTokens).
  const plainInputTokens = Math.max(0, usage.promptTokens - cachedTokens - cacheWriteTokens);
  return (
    (plainInputTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedTokens / 1_000_000) * cachedRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate +
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
