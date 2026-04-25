import { getModelPricing } from './model-pricing';

// =============================================================================
// Model Registry
// =============================================================================

export interface ModelConfig {
  /** The actual model ID to send to OpenRouter */
  openrouterId: string;
  inputPer1M: number;   // Cost per 1M input tokens (USD)
  outputPer1M: number;  // Cost per 1M output tokens (USD)
  contextWindow: number;
  tier: 'free' | 'paid';
  cacheReadPer1M?: number;   // Cost per 1M cached-read tokens (USD)
  cacheWritePer1M?: number;  // Cost per 1M cache-write tokens (USD)
}

/**
 * Kortix model registry — maps model IDs exposed through the Kortix provider
 * to their OpenRouter equivalents with pricing.
 *
 * Model IDs use the real provider/model format (e.g. "moonshotai/kimi-k2.5")
 * so users see actual model names, not opaque aliases.
 *
 * Any model NOT in this registry is passed through to OpenRouter as-is
 * with live pricing from models.dev (or zero if unknown).
 */
export const MODELS: Record<string, ModelConfig> = {
  'minimax/minimax-m2.7': {
    openrouterId: 'minimax/minimax-m2.7',
    inputPer1M: 0.30,
    outputPer1M: 1.20,
    contextWindow: 204800,
    tier: 'free',
    cacheReadPer1M: 0.06,
  },
  'z-ai/glm-5-turbo': {
    openrouterId: 'z-ai/glm-5-turbo',
    inputPer1M: 1.20,
    outputPer1M: 4.00,
    contextWindow: 202752,
    tier: 'free',
    cacheReadPer1M: 0.24,
  },
  'moonshotai/kimi-k2.5': {
    openrouterId: 'moonshotai/kimi-k2.5',
    inputPer1M: 0.45,
    outputPer1M: 2.20,
    contextWindow: 262144,
    tier: 'free',
    cacheReadPer1M: 0.225,
  },
  'minimax/minimax-m2.5': {
    openrouterId: 'minimax/minimax-m2.5',
    inputPer1M: 0.20,
    outputPer1M: 1.17,
    contextWindow: 196608,
    tier: 'free',
    cacheReadPer1M: 0.10,
  },
  // Opencode-side aliases (from core/kortix-master/opencode/opencode.jsonc).
  // Opencode's openai-compatible client ships the alias as the model param
  // — e.g. `kortix/minimax-m27`, not the resolved upstream id — so the
  // router needs to translate them. Without these, every agent call from
  // opencode 400s with "is not a valid model ID" and PM/team hangs at
  // 0 tokens / ready_at=null.
  'kortix/minimax-m27': {
    openrouterId: 'minimax/minimax-m2.7',
    inputPer1M: 0.30,
    outputPer1M: 1.20,
    contextWindow: 204800,
    tier: 'free',
    cacheReadPer1M: 0.06,
  },
  'kortix/glm-turbo': {
    openrouterId: 'z-ai/glm-5-turbo',
    inputPer1M: 1.20,
    outputPer1M: 4.00,
    contextWindow: 202752,
    tier: 'free',
    cacheReadPer1M: 0.24,
  },
  'kortix/kimi': {
    openrouterId: 'moonshotai/kimi-k2.5',
    inputPer1M: 0.45,
    outputPer1M: 2.20,
    contextWindow: 262144,
    tier: 'free',
    cacheReadPer1M: 0.225,
  },
  'kortix/minimax': {
    openrouterId: 'minimax/minimax-m2.5',
    inputPer1M: 0.20,
    outputPer1M: 1.17,
    contextWindow: 196608,
    tier: 'free',
    cacheReadPer1M: 0.10,
  },
};

/**
 * Default model for Kortix-managed contexts (cron, memory, etc.)
 * that need a sensible default without user input.
 */
export const DEFAULT_MODEL_ID = 'minimax/minimax-m2.7';

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
