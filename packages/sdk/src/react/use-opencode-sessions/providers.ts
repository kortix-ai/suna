'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { useKortixRouteProjectId } from '../route-project';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap, getLSCache, setLSCache, LS_PROVIDERS, CACHE_SCOPE_GLOBAL } from './shared';
import { getProjectModelPicker } from '../../core/rest/projects-client';
import {
  filterToGatewayProviders,
  GATEWAY_PROVIDER_IDS,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasModels,
} from '../provider-selection';
import { providerQueryPlan } from './provider-load-plan';

// ============================================================================
// Provider Hooks
// ============================================================================

export { GATEWAY_PROVIDER_IDS };

/**
 * The provider list a host renders its model picker from.
 *
 * Gateway mode is the only mode. Inside a project route the answer is ALWAYS
 * the gateway's `/model-picker` catalog, shaped as the single synthetic
 * `kortix` provider — never the sandbox's own `provider.list`, never gated on a
 * project flag, never gated on the runtime being up (the picker must paint
 * before the sandbox boots). The retired `llm_gateway` flag used to fork this
 * hook into a "native" branch that read the runtime's providers and filtered
 * `kortix` OUT; no session can use a native OpenCode provider (the daemon
 * strips provider keys from OpenCode's env), so that branch was a dead picker.
 *
 * Outside a project route there is no model-picker to ask, so the runtime's
 * own list is the source, once the runtime is reachable.
 */
export function useOpenCodeProviders() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const projectId = useKortixRouteProjectId();
  const plan = providerQueryPlan({ projectId, runtimeReady });

  const gatewayCacheScope = projectId ? `proj:${projectId}:gateway` : CACHE_SCOPE_GLOBAL;
  const gatewayProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: ['project-providers', projectId, 'gateway'],
    queryFn: async () => {
      const catalog = await getProjectModelPicker(projectId!);
      const providers = projectLlmCatalogToProviderList(catalog);
      setLSCache(LS_PROVIDERS, providers, gatewayCacheScope);
      return providers;
    },
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, gatewayCacheScope);
      if (!providerListHasModels(cached)) return undefined;
      const providers = filterToGatewayProviders(cached as ProviderListResponse);
      return providerListHasModels(providers) ? providers : undefined;
    },
    enabled: plan.gateway,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount) => failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  const runtimeProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: opencodeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      const providers = normalizeProviderList(unwrap(result));

      // During boot the OpenCode server frequently answers /provider/list
      // BEFORE its provider config is wired up, returning zero CONNECTED
      // providers (→ zero models). With staleTime:Infinity such an empty answer
      // would be cached for the whole session and never refetched, AND
      // persisted to the localStorage cache below — poisoning the first frame
      // of every future session too. Treat a model-less response as a transient
      // boot state: throw so React Query retries it (with backoff), and never
      // cache or persist it.
      if (!providerListHasModels(providers)) {
        throw new Error(
          'opencode provider list has no connected models yet — sandbox still warming up',
        );
      }

      setLSCache(LS_PROVIDERS, providers, CACHE_SCOPE_GLOBAL);
      return providers;
    },
    // Only ever serve a model-bearing placeholder. A previously-poisoned cache
    // (written before this guard existed) is ignored so it can't paint empty.
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, CACHE_SCOPE_GLOBAL);
      return providerListHasModels(cached) ? cached : undefined;
    },
    enabled: plan.runtime,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (runtime up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount) => failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  return projectId ? gatewayProvidersQuery : runtimeProvidersQuery;
}
