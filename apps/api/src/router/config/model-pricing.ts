import type { Effect } from 'effect';
/**
 * models.dev pricing — live LLM pricing from the open-source models database.
 *
 * Fetches https://models.dev/api.json on boot and refreshes every 24 h in the
 * background (non-blocking). Builds a flat Map<modelId, pricing> plus a
 * normalized-id index for resilient provider-native lookups.
 *
 * Usage:
 *   import { initModelPricing, getModelPricing } from './model-pricing';
 *   await initModelPricing();                       // call once at boot
 *   const p = getModelPricing('claude-sonnet-4-20250514');
 *   // => { inputPer1M: 3, outputPer1M: 15 } | null
 */
import { routerFetch, routerSleep, runRouterInterval } from '../effect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
}

const normModelId = (id: string): string => id.toLowerCase().replace(/\./g, '-');

/** Shape of a single model in the models.dev API response. */
interface ModelsDevModel {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number };
  [key: string]: unknown;
}

/** Shape of a provider in the models.dev API response. */
interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

/** The full API response: { [providerId]: ModelsDevProvider } */
type ModelsDevApiResponse = Record<string, ModelsDevProvider>;

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

/** In-memory pricing lookup.  `null` key means "not yet loaded". */
let pricingMap: Map<string, ModelPricingEntry> = new Map();
/** Normalised-id index (lowercase, dots→dashes) for resilient lookups. */
let normIndex: Map<string, ModelPricingEntry> = new Map();

let refreshTimer: { active: boolean } | null = null;

let lastFetchedAt: Date | null = null;
let modelCount = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a model ID (provider-native, e.g. `claude-sonnet-4-20250514`).
 * Returns `null` if the model is unknown or pricing hasn't been fetched yet.
 */
export function getModelPricing(modelId: string): ModelPricingEntry | null {
  const exact = pricingMap.get(modelId);
  if (exact) return exact;
  const nq = normModelId(modelId);
  const norm = normIndex.get(nq);
  if (norm) return norm;
  for (const [key, entry] of normIndex) {
    if (key.startsWith(nq) || nq.startsWith(key)) return entry;
  }
  return null;
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
    refreshTimer = { active: true };
    runRouterInterval(async () => {
      if (!refreshTimer?.active) return;
      await refreshPricing();
    }, REFRESH_INTERVAL_MS);
  }
}

/**
 * Stop the background refresh timer.  Call on graceful shutdown.
 */
export function stopModelPricing(): void {
  if (refreshTimer) {
    refreshTimer.active = false;
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function refreshPricing(): Promise<void> {
  try {
    const controller = new AbortController();
    void routerSleep(FETCH_TIMEOUT_MS).then(() => controller.abort());

    const res = await routerFetch(API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[model-pricing] models.dev returned ${res.status} — skipping refresh`);
      return;
    }

    const data = (await res.json()) as ModelsDevApiResponse;
    const newMap = new Map<string, ModelPricingEntry>();
    const newNorm = new Map<string, ModelPricingEntry>();

    for (const provider of Object.values(data)) {
      if (!provider?.models) continue;
      for (const model of Object.values(provider.models)) {
        const input = model.cost?.input;
        const output = model.cost?.output;
        if (typeof input !== 'number' || typeof output !== 'number' || (input <= 0 && output <= 0))
          continue;
        const entry: ModelPricingEntry = { inputPer1M: input, outputPer1M: output };
        if (typeof model.cost?.cache_read === 'number')
          entry.cacheReadPer1M = model.cost.cache_read;
        if (!newMap.has(model.id)) newMap.set(model.id, entry);
        const nk = normModelId(model.id);
        if (!newNorm.has(nk)) newNorm.set(nk, entry);
      }
    }

    // Atomic swap — readers never see a partially-built map
    pricingMap = newMap;
    normIndex = newNorm;
    modelCount = newMap.size;
    lastFetchedAt = new Date();

    console.log(`[model-pricing] Loaded ${newMap.size} model prices from models.dev (live)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      console.warn('[model-pricing] Fetch timed out — will retry on next refresh');
    } else {
      console.error('[model-pricing] Fetch error:', message);
    }
  }
}
