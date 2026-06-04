/**
 * models.dev pricing — live LLM pricing from the open-source models database.
 *
 * Fetches https://models.dev/api.json on boot and refreshes every 24 h in the
 * background (non-blocking). Builds a flat Map<modelId, pricing> for the
 * providers we proxy (anthropic, openai, xai, google, groq, deepseek).
 *
 * Usage:
 *   import { initModelPricing, getModelPricing } from './model-pricing';
 *   await initModelPricing();                       // call once at boot
 *   const p = getModelPricing('claude-sonnet-4-20250514');
 *   // => { inputPer1M: 3, outputPer1M: 15 } | null
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

/** Shape of a single model in the models.dev API response. */
interface ModelsDevModel {
  id: string;
  cost?: { input?: number; output?: number };
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

/** Only ingest pricing for providers we actually proxy. */
const PROXY_PROVIDERS = [
  'anthropic',
  'openai',
  'xai',
  'google',
  'groq',
  'deepseek',
] as const;

/** How often to refresh pricing in the background (ms). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

/** Fetch timeout (ms). */
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** In-memory pricing lookup.  `null` key means "not yet loaded". */
let pricingMap: Map<string, ModelPricingEntry> = new Map();

let refreshTimer: ReturnType<typeof setInterval> | null = null;

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
  return pricingMap.get(modelId) ?? null;
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

/**
 * Return a summary for startup logging.
 */
export function getModelPricingStatus(): {
  loaded: boolean;
  modelCount: number;
  lastFetchedAt: Date | null;
} {
  return {
    loaded: pricingMap.size > 0,
    modelCount,
    lastFetchedAt,
  };
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
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[model-pricing] models.dev returned ${res.status} — skipping refresh`);
      return;
    }

    const data = (await res.json()) as ModelsDevApiResponse;
    const newMap = new Map<string, ModelPricingEntry>();

    for (const providerId of PROXY_PROVIDERS) {
      const provider = data[providerId];
      if (!provider?.models) continue;

      for (const model of Object.values(provider.models)) {
        const input = model.cost?.input;
        const output = model.cost?.output;
        if (typeof input === 'number' && typeof output === 'number' && (input > 0 || output > 0)) {
          newMap.set(model.id, { inputPer1M: input, outputPer1M: output });
        }
      }
    }

    // Atomic swap — readers never see a partially-built map
    pricingMap = newMap;
    modelCount = newMap.size;
    lastFetchedAt = new Date();

    console.log(
      `[model-pricing] Loaded ${newMap.size} model prices from models.dev ` +
        `(${PROXY_PROVIDERS.join(', ')})`,
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
