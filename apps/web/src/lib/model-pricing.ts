'use client';

import type { CatalogCost } from '@kortix/llm-catalog';
import {
  getProjectLlmCatalogProviders,
  type ModelCostRates,
  type ModelPricingLookup,
} from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

/**
 * Per-million-token rates for a session's turns.
 *
 * The primary source is the provider list the session already has (OpenCode's
 * `/provider`, or the gateway picker — both carry `cost`). The fallback, for a
 * provider/model the list does not carry (e.g. a provider whose key was
 * removed after the turn ran), is the API's live models.dev projection
 * `GET /projects/:id/llm-catalog/providers`. It loads only on the first miss,
 * and it shares its React Query key with the provider modal's catalog fetch
 * (`use-live-catalog.ts`). The browser never fetches models.dev itself: that
 * was a 4.9 MB third-party download on every session open.
 */

interface CatalogPricingSource {
  providers: Array<{ id: string; models: Array<{ id: string; cost?: CatalogCost }> }>;
}

/** Same key and fetch as `useLiveLlmProviderCatalog` — one request per project. */
function catalogProvidersQueryKey(projectId: string | null) {
  return ['llm-catalog-providers', projectId] as const;
}

export function buildCatalogPricingMap(catalog: CatalogPricingSource): Map<string, ModelCostRates> {
  const map = new Map<string, ModelCostRates>();
  for (const provider of catalog.providers ?? []) {
    for (const model of provider.models ?? []) {
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
      const key = `${provider.id}/${model.id}`;
      if (!map.has(key)) map.set(key, entry);
    }
  }
  return map;
}

// Every SessionTurn calls the hook; build each catalog's map once.
const pricingMapByCatalog = new WeakMap<object, Map<string, ModelCostRates>>();
function pricingMapFor(catalog: CatalogPricingSource): Map<string, ModelCostRates> {
  let map = pricingMapByCatalog.get(catalog);
  if (!map) {
    map = buildCatalogPricingMap(catalog);
    pricingMapByCatalog.set(catalog, map);
  }
  return map;
}

function lookupCachedPricing(
  providerID: string,
  modelID: string,
  cache: ReadonlyMap<string, ModelCostRates>,
): ModelCostRates | null {
  const modelCandidates = [modelID, ...(modelID.includes('/') ? [] : [`${providerID}/${modelID}`])];
  for (const modelCandidate of modelCandidates) {
    const hit = cache.get(`${providerID}/${modelCandidate}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * `cachedPricing` undefined means "catalog not loaded": a BYO-provider miss
 * then calls `onCatalogMiss` so the caller can load it.
 */
export function createModelPricingLookup(
  providers: ProviderListResponse | undefined,
  cachedPricing?: ReadonlyMap<string, ModelCostRates>,
  onCatalogMiss?: (providerID: string, modelID: string) => void,
): ModelPricingLookup {
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

    if (!cachedPricing) {
      onCatalogMiss?.(providerID, modelID);
      return null;
    }
    return lookupCachedPricing(providerID, modelID, cachedPricing);
  };
}

export function useModelPricingLookup(
  providers: ProviderListResponse | undefined,
): ModelPricingLookup {
  // Every caller renders under `/projects/[id]/…` (session chat, the
  // sub-session modal, the context modal). No project id → no fallback.
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const [catalogWanted, setCatalogWanted] = useState(false);
  // A disabled query still returns (and subscribes to) data another observer
  // cached, so only the first turn that misses has to enable the fetch.
  const catalogQuery = useQuery({
    queryKey: catalogProvidersQueryKey(projectId),
    queryFn: () => getProjectLlmCatalogProviders(projectId!),
    enabled: catalogWanted && !!projectId,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
  const catalog = catalogQuery.data as CatalogPricingSource | undefined;
  const cachedPricing = useMemo(() => (catalog ? pricingMapFor(catalog) : undefined), [catalog]);

  // Called during a consumer's render (inside `useMemo`), so the state update
  // is deferred to a microtask instead of running mid-render.
  const onCatalogMiss = useCallback(() => {
    if (catalogWanted || !projectId) return;
    queueMicrotask(() => setCatalogWanted(true));
  }, [catalogWanted, projectId]);

  return useMemo(
    () => createModelPricingLookup(providers, cachedPricing, onCatalogMiss),
    [providers, cachedPricing, onCatalogMiss],
  );
}
