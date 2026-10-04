/**
 * models.dev pricing — live LLM pricing from the open-source models database.
 *
 * Fetches https://models.dev/api.json on boot and refreshes every 24 h in the
 * background (non-blocking). Prices remain qualified by provider and model.
 *
 * Usage:
 *   import { initModelPricing, getModelPricing } from './model-pricing';
 *   await initModelPricing();                       // call once at boot
 *   const p = getModelPricing('anthropic', 'claude-sonnet-4-20250514');
 *   // => { inputPer1M: 3, outputPer1M: 15 } | null
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
  tiers?: ModelPricingTier[];
  contextOver200k?: ModelPricingTier;
}

export interface ModelPricingTier extends ModelPricingEntry {
  contextThreshold: number;
}

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: Array<{
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tier?: { type?: string; size?: number };
  }>;
  context_over_200k?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/** Shape of a single model in the models.dev API response. */
interface ModelsDevModel {
  id: string;
  cost?: ModelsDevCost;
  [key: string]: unknown;
}

/** Shape of a provider in the models.dev API response. */
interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

/** The full API response: { [providerId]: ModelsDevProvider } */
export type ModelsDevApiResponse = Record<string, ModelsDevProvider>;
export type ModelPricingIndex = Map<string, Map<string, ModelPricingEntry>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://models.dev/api.json';

/** How often to refresh pricing in the background (ms). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

/** Fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pricingIndex: ModelPricingIndex = new Map();

let refreshTimer: ReturnType<typeof setInterval> | null = null;

let lastFetchedAt: Date | null = null;
let modelCount = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an exact provider and exact provider-native model ID.
 * Returns `null` if the model is unknown or pricing hasn't been fetched yet.
 */
export function getModelPricing(providerId: string, modelId: string): ModelPricingEntry | null {
  return lookupModelPricing(pricingIndex, providerId, modelId);
}

/**
 * Initialise the pricing cache.  Call once at server boot.
 *
 * - First fetch is **awaited** so pricing is available before the first request.
 * - If the fetch fails, pricing starts empty (getModelPricing returns null)
 *   and the 24 h timer will retry.
 * - Subsequent refreshes are non-blocking (fire-and-forget).
 */
export async function initModelPricing(): Promise<void> {
  // First fetch — await so pricing is ready before first request
  await refreshPricing();

  // Schedule background refresh (non-blocking)
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refreshPricing().catch((err) =>
        console.error('[model-pricing] Background refresh failed:', err),
      );
    }, REFRESH_INTERVAL_MS);

    // Don't let the timer keep the process alive
    if (typeof refreshTimer === 'object' && 'unref' in refreshTimer) {
      refreshTimer.unref();
    }
  }
}

/**
 * Stop the background refresh timer.  Call on graceful shutdown.
 */
export function stopModelPricing(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function refreshPricing(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[model-pricing] models.dev returned ${res.status} — skipping refresh`);
      return;
    }

    const data = (await res.json()) as ModelsDevApiResponse;
    const newIndex = buildModelPricingIndex(data);

    // Atomic swap — readers never see a partially-built map
    pricingIndex = newIndex;
    modelCount = [...newIndex.values()].reduce((count, models) => count + models.size, 0);
    lastFetchedAt = new Date();

    console.log(
      `[model-pricing] Loaded ${modelCount} provider-qualified model prices from models.dev (live)`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      console.warn('[model-pricing] Fetch timed out — will retry on next refresh');
    } else {
      console.error('[model-pricing] Fetch error:', message);
    }
  }
}

function pricingEntry(cost: ModelsDevCost | undefined): ModelPricingEntry | null {
  if (!cost) return null;
  const input = cost.input;
  const output = cost.output;
  if (typeof input !== 'number' || typeof output !== 'number' || (input <= 0 && output <= 0)) {
    return null;
  }

  const entry: ModelPricingEntry = {
    inputPer1M: input,
    outputPer1M: output,
  };
  if (typeof cost.cache_read === 'number') entry.cacheReadPer1M = cost.cache_read;
  if (typeof cost.cache_write === 'number') entry.cacheWritePer1M = cost.cache_write;
  const tiers = cost.tiers
    ?.filter((tier) => tier.tier?.type === 'context' && typeof tier.tier.size === 'number')
    .map((tier) => {
      const mapped: ModelPricingTier = {
        inputPer1M: tier.input ?? input,
        outputPer1M: tier.output ?? output,
        contextThreshold: tier.tier!.size!,
      };
      if (typeof tier.cache_read === 'number') mapped.cacheReadPer1M = tier.cache_read;
      if (typeof tier.cache_write === 'number') mapped.cacheWritePer1M = tier.cache_write;
      return mapped;
    });
  if (tiers?.length) entry.tiers = tiers;

  const over200k = cost.context_over_200k;
  if (over200k) {
    const mapped: ModelPricingTier = {
      inputPer1M: over200k.input ?? input,
      outputPer1M: over200k.output ?? output,
      contextThreshold: 200_000,
    };
    if (typeof over200k.cache_read === 'number') mapped.cacheReadPer1M = over200k.cache_read;
    if (typeof over200k.cache_write === 'number') mapped.cacheWritePer1M = over200k.cache_write;
    entry.contextOver200k = mapped;
  }
  return entry;
}

export function buildModelPricingIndex(data: ModelsDevApiResponse): ModelPricingIndex {
  const index: ModelPricingIndex = new Map();
  for (const [providerKey, provider] of Object.entries(data)) {
    if (!provider?.models) continue;
    const providerId = provider.id || providerKey;
    const models = new Map<string, ModelPricingEntry>();
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const entry = pricingEntry(model.cost);
      if (!entry) continue;
      models.set(model.id || modelKey, entry);
    }
    if (models.size) index.set(providerId, models);
  }
  return index;
}

export function lookupModelPricing(
  index: ModelPricingIndex,
  providerId: string,
  modelId: string,
): ModelPricingEntry | null {
  return index.get(providerId)?.get(modelId) ?? null;
}
