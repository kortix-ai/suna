'use client';

import type { ProviderListResponse } from '@kortix/sdk/react';
import type { ModelCostRates, ModelPricingLookup } from '@kortix/sdk/turns';
import { useEffect, useMemo, useState } from 'react';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 15_000;

let pricingCache: Map<string, ModelCostRates> | null = null;
let pricingPromise: Promise<Map<string, ModelCostRates>> | null = null;

type ModelsDevModel = {
  id?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

async function loadModelsDevPricing(): Promise<Map<string, ModelCostRates>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return new Map();
    const data = (await res.json()) as Record<string, ModelsDevProvider>;
    return buildModelsDevPricingMap(data);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeout);
  }
}

export function buildModelsDevPricingMap(
  data: Record<string, ModelsDevProvider>,
): Map<string, ModelCostRates> {
  const map = new Map<string, ModelCostRates>();

  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider?.models) continue;
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const input = model.cost?.input;
      const output = model.cost?.output;
      if (typeof input !== 'number' || typeof output !== 'number') continue;
      if (input <= 0 && output <= 0) continue;

      const entry: ModelCostRates = {
        inputPer1M: input,
        outputPer1M: output,
        cacheReadPer1M: model.cost?.cache_read,
      };
      if (typeof model.cost?.cache_write === 'number') {
        entry.cacheWritePer1M = model.cost.cache_write;
      }
      const modelId = model.id ?? modelKey;
      const keys = new Set([`${providerId}/${modelId}`, `${providerId}/${modelKey}`]);
      for (const key of keys) {
        if (key && !map.has(key)) map.set(key, entry);
      }
    }
  }
  return map;
}

export function prefetchModelPricing(): void {
  if (pricingCache || pricingPromise) return;
  pricingPromise = loadModelsDevPricing().then((map) => {
    pricingCache = map;
    return map;
  });
}

function lookupCachedPricing(
  providerID: string,
  modelID: string,
  cache: ReadonlyMap<string, ModelCostRates> | null | undefined,
): ModelCostRates | null {
  if (!cache) return null;
  const modelCandidates = [modelID, ...(modelID.includes('/') ? [] : [`${providerID}/${modelID}`])];
  for (const modelCandidate of modelCandidates) {
    const hit = cache.get(`${providerID}/${modelCandidate}`);
    if (hit) return hit;
  }
  return null;
}

export function createModelPricingLookup(
  providers: ProviderListResponse | undefined,
  cachedPricing?: ReadonlyMap<string, ModelCostRates>,
): ModelPricingLookup {
  const cache = cachedPricing ?? pricingCache;
  return (providerID: string, modelID: string) => {
    const provider = providers?.all?.find((p) => p.id === providerID);
    const model = provider?.models?.[modelID] as
      | { cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number } }
      | undefined;
    if (model?.cost && (model.cost.input || model.cost.output)) {
      const rates: ModelCostRates = {
        inputPer1M: model.cost.input ?? 0,
        outputPer1M: model.cost.output ?? 0,
        cacheReadPer1M: model.cost.cache_read,
      };
      if (typeof model.cost.cache_write === 'number') {
        rates.cacheWritePer1M = model.cost.cache_write;
      }
      return rates;
    }

    if (providerID === 'kortix') {
      return null;
    }

    return lookupCachedPricing(providerID, modelID, cache);
  };
}

export function useModelPricingLookup(
  providers: ProviderListResponse | undefined,
): ModelPricingLookup {
  const [pricingReady, setPricingReady] = useState(!!pricingCache);

  useEffect(() => {
    prefetchModelPricing();
    if (pricingCache) return;
    pricingPromise?.then(() => setPricingReady(true));
  }, []);

  return useMemo(
    () =>
      createModelPricingLookup(providers, pricingReady ? (pricingCache ?? undefined) : undefined),
    [providers, pricingReady],
  );
}
