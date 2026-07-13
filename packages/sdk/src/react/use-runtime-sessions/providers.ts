'use client';

import { useQuery } from '@tanstack/react-query';
import { useKortixRouteProjectId } from '../route-project';
import { runtimeKeys } from './keys';
import { useCurrentRuntime } from '../use-current-runtime';
import type { ProviderListResponse } from './keys';
import { getLSCache, setLSCache, LS_PROVIDERS, CACHE_SCOPE_GLOBAL } from './shared';
import {
  getProjectDetail,
  getProjectModelPicker,
} from '../../core/rest/projects-client';
import {
  filterToGatewayProviders,
  filterToNativeProviders,
  GATEWAY_PROVIDER_IDS,
  projectLlmCatalogToProviderList,
  providerListHasModels,
} from '../provider-selection';

// ============================================================================
// Provider Hooks
// ============================================================================

export { GATEWAY_PROVIDER_IDS };

export function useRuntimeProviders() {
  const routeProjectId = useKortixRouteProjectId();
  const activeProjectId = useCurrentRuntime((state) => state.projectId);
  const projectId = routeProjectId ?? activeProjectId;
  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const projectGatewayEnabled =
    projectId ? projectDetailQuery.data?.project.experimental?.llm_gateway === true : false;
  const projectModeKnown = !projectId || projectDetailQuery.isSuccess;
  // BYOK makes the connected model set project-specific (a provider connected
  // in one project must NOT leak into another, nor linger after removal), so
  // the persisted placeholder is scoped per project — not the old global scope.
  const cacheScope = projectId
    ? `proj:${projectId}:${projectGatewayEnabled ? 'gateway' : 'native'}`
    : CACHE_SCOPE_GLOBAL;
  return useQuery<ProviderListResponse>({
    queryKey: projectId
      ? ['project-providers', projectId, projectGatewayEnabled ? 'gateway' : 'native']
      : runtimeKeys.providers(),
    queryFn: async () => {
      if (!projectId) return { all: [], connected: [], default: {} } as ProviderListResponse;
      const catalog = await getProjectModelPicker(projectId);
      const providers = projectLlmCatalogToProviderList(catalog);
      setLSCache(LS_PROVIDERS, providers, cacheScope);
      return providers;
    },
    // Only ever serve a model-bearing placeholder. A previously-poisoned cache
    // (written before this guard existed) is ignored so it can't paint empty.
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, cacheScope);
      if (!providerListHasModels(cached)) return undefined;
      // Old gateway caches may have been persisted before the source filter —
      // clean them on read, but native-mode projects must see the runtime's
      // actual provider list for v0.9.68/backward-compatible fallback.
      if (projectGatewayEnabled) {
        const gatewayProviders = filterToGatewayProviders(cached as ProviderListResponse);
        return providerListHasModels(gatewayProviders) ? gatewayProviders : undefined;
      }
      if (projectId && !projectGatewayEnabled) {
        const nativeProviders = filterToNativeProviders(cached as ProviderListResponse);
        return providerListHasModels(nativeProviders) ? nativeProviders : undefined;
      }
      return cached;
    },
    enabled: Boolean(projectId && projectModeKnown),
    staleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: false,
  });
}
