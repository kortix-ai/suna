import { getModelPricing } from './model-pricing';

// =============================================================================
// Model Registry
// =============================================================================

export interface ModelConfig {
  /** The actual model ID to send to OpenRouter */
  openrouterId: string;
  inputPer1M: number; // Cost per 1M input tokens (USD)
  outputPer1M: number; // Cost per 1M output tokens (USD)
  contextWindow: number;
  tier: 'free' | 'paid';
  cacheReadPer1M?: number; // Cost per 1M cached-read tokens (USD)
  cacheWritePer1M?: number; // Cost per 1M cache-write tokens (USD)
}

/**
 * Legacy Kortix model registry for the `/v1/router` passthrough.
 *
 * Emptied: opencode now talks to the LLM GATEWAY (KORTIX_LLM_BASE_URL) with the
 * managed catalog ids — it no longer sends the old `kortix/minimax-m27` /
 * `kortix/kimi` style aliases to `/v1/router`. The router is now a pure
 * OpenRouter passthrough: any model id is forwarded as-is with live pricing from
 * models.dev (registry metadata is only an optional fallback). Add an entry here
 * only if a client sends an alias OpenRouter wouldn't recognise.
 */
const MODELS: Record<string, ModelConfig> = {};

// =============================================================================
// Model Resolution
// =============================================================================

/**
 * Resolve a user-provided model ID to a ModelConfig.
 *
 * Priority:
 * 1. models.dev live pricing (always current, refreshed every 24h) — pricing only
 * 2. MODELS registry — provides contextWindow, tier, and cache pricing,
 *    and acts as pricing fallback when models.dev hasn't loaded yet or is unknown
 * 3. Zero pricing (billing skipped) if completely unknown
 */
export function getModel(modelId: string): ModelConfig {
  const openrouterId = modelId.startsWith('openrouter/')
    ? modelId.replace('openrouter/', '')
    : modelId;

  const registryEntry = MODELS[modelId] ?? MODELS[openrouterId];

  // models.dev is source of truth for pricing — always wins if available
  const livePricing = getModelPricing(modelId) ?? getModelPricing(openrouterId);

  if (livePricing) {
    return {
      openrouterId,
      // Merge registry metadata with live pricing
      contextWindow: registryEntry?.contextWindow ?? 128000,
      tier: registryEntry?.tier ?? 'paid',
      cacheReadPer1M: registryEntry?.cacheReadPer1M,
      cacheWritePer1M: registryEntry?.cacheWritePer1M,
      // Pricing always from models.dev
      inputPer1M: livePricing.inputPer1M,
      outputPer1M: livePricing.outputPer1M,
    };
  }

  // models.dev unknown — fall back to hardcoded registry prices
  if (registryEntry) {
    return registryEntry;
  }

  return {
    openrouterId,
    inputPer1M: 0,
    outputPer1M: 0,
    contextWindow: 128000,
    tier: 'paid',
  };
}

/**
 * Resolve a model ID to the OpenRouter model ID.
 * This is the ID that gets sent in the request body to OpenRouter.
 */
export function resolveOpenRouterId(modelId: string): string {
  return getModel(modelId).openrouterId;
}

/**
 * Get all available models for /v1/models endpoint.
 */
export function getAllModels() {
  return Object.entries(MODELS).map(([id, cfg]) => ({
    id,
    object: 'model' as const,
    owned_by: 'kortix',
    context_window: cfg.contextWindow,
    pricing: {
      input: cfg.inputPer1M,
      output: cfg.outputPer1M,
    },
    tier: cfg.tier,
  }));
}
