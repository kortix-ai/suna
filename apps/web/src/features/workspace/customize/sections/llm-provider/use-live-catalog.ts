'use client';

import {
  applyLiveLlmProviderCatalog,
  getLlmProviderCatalogRevision,
  subscribeLlmProviderCatalog,
} from '@/lib/llm-providers';
import { getProjectLlmCatalogProviders } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Re-renders whenever `LLM_PROVIDERS` (apps/web/src/lib/llm-providers.ts) is
 * reassigned by a live catalog fetch — a plain revision counter behind
 * `useSyncExternalStore`, not a copy of the data itself. Components that
 * already read `LLM_PROVIDERS` at render time (via `useMemo`, etc.) just
 * need to be in the render tree that re-runs; calling this hook is what
 * causes that re-run.
 */
export function useLlmProviderCatalogRevision(): number {
  return useSyncExternalStore(subscribeLlmProviderCatalog, getLlmProviderCatalogRevision, () => 0);
}

/**
 * Fetches the LIVE, server-refreshed provider catalog
 * (`GET /projects/:id/llm-catalog/providers` — runtimeModelCatalog, the same
 * 24h-refreshed, atomic-last-known-good source every other gateway endpoint
 * reads) and pushes it over the baked seed via `applyLiveLlmProviderCatalog`.
 * Mount this ONCE near the top of the provider modal (not per-tab) — every
 * consumer of `LLM_PROVIDERS` elsewhere in the app benefits from the same
 * live data once it lands, since the exported bindings are reassigned in
 * place (see llm-providers.ts's module doc comment).
 *
 * Same auth as `/llm-catalog`; non-secret model metadata, so it is read
 * wherever the connect modal is — see the route's doc comment.
 *
 * staleTime is long: this is catalog metadata (env vars, model names), not a
 * hot path — matching the API's own 24h refresh cadence is plenty fresh.
 */
export function useLiveLlmProviderCatalog(projectId: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ['llm-catalog-providers', projectId],
    queryFn: () => getProjectLlmCatalogProviders(projectId),
    enabled: enabled && !!projectId,
    staleTime: 60 * 60 * 1000, // 1h — well under the API's 24h refresh, avoids refetch storms
    retry: 1,
  });

  useEffect(() => {
    if (query.data) applyLiveLlmProviderCatalog(query.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  return query;
}
