'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { useKortixRouteProjectId } from '../route-project';
import { contract } from '../query-contracts';
import { qk } from '../query-keys';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap, getLSCache, setLSCache, LS_PROVIDERS, CACHE_SCOPE_GLOBAL } from './shared';
import {
  getProjectDetail,
  getProjectModelPicker,
  listProjectSecrets,
} from '../../core/rest/projects-client';
import {
  filterToGatewayProviders,
  filterToNativeProviders,
  GATEWAY_PROVIDER_IDS,
  LLM_PROVIDER_CREDENTIALS,
  mergeProjectSecretConnectedProviders,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasModels,
} from '../provider-selection';
import { shouldLoadProjectModelPicker } from './provider-load-plan';

// ============================================================================
// Provider Hooks
// ============================================================================

export { GATEWAY_PROVIDER_IDS };

export function useOpenCodeProviders() {
  const queryClient = useQueryClient();
  const runtimeReady = useOpenCodeRuntimeReady();
  const projectId = useKortixRouteProjectId();
  const projectDetailQuery = useQuery({
    // Same fetcher and same response shape every other `getProjectDetail`
    // reader caches under `qk.project.detail(id)` — sharing the key (instead
    // of the old standalone flat `project-detail` array literal) is what stops
    // this hook from firing a second `GET /projects/:id/detail` on every
    // session page purely to duplicate data the project shell already has.
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    ...contract('config'),
  });
  const projectGatewayEnabled =
    projectId ? projectDetailQuery.data?.project.experimental?.llm_gateway === true : false;
  const projectModeKnown = !projectId || projectDetailQuery.isSuccess;
  const gatewayCacheScope = projectId ? `proj:${projectId}:gateway` : CACHE_SCOPE_GLOBAL;
  const gatewayProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: ['project-providers', projectId, 'gateway'],
    queryFn: async () => {
      // The picker is read through ITS OWN entry (`qk.project.modelPicker`),
      // which `useProjectModels` also observes. Calling the fetcher directly
      // here made two concurrent `GET /model-picker` on every session open
      // (measured: both 83 KB, 1 ms apart). fetchQuery dedupes the in-flight
      // read and fills the shared entry.
      const catalog = await queryClient.fetchQuery({
        queryKey: qk.project.modelPicker(projectId!),
        queryFn: () => getProjectModelPicker(projectId!),
        ...contract('config'),
      });
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
    enabled: shouldLoadProjectModelPicker({
      projectId,
      projectModeKnown,
      projectGatewayEnabled,
    }),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount) =>
      (!projectModeKnown || projectGatewayEnabled) && failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  // BYOK makes the connected model set project-specific. A provider connected
  // in one project must not leak into another or remain after removal.
  const nativeCacheScope = projectId ? `proj:${projectId}:native` : CACHE_SCOPE_GLOBAL;
  const nativeProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: projectId ? ['project-providers', projectId, 'native'] : opencodeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      let rawProviders = normalizeProviderList(unwrap(result));
      if (projectId) {
        const secrets = await listProjectSecrets(projectId);
        const items = Array.isArray(secrets) ? secrets : (secrets.items ?? []);
        const secretNames = new Set(items.map((secret: { name: string }) => secret.name));
        rawProviders = mergeProjectSecretConnectedProviders(
          rawProviders,
          secretNames,
          LLM_PROVIDER_CREDENTIALS,
        );
      }
      const providers = projectId ? filterToNativeProviders(rawProviders) : rawProviders;

      // During sandbox boot the OpenCode server frequently answers
      // /provider/list BEFORE its provider config is wired up, returning zero
      // CONNECTED providers (→ zero models). With staleTime:Infinity such an
      // empty answer would be cached for the whole session and never refetched,
      // AND persisted to the global localStorage cache below — poisoning the
      // first frame of every future session too. That is the "model picker
      // never shows up" bug. Treat a model-less response as a transient boot
      // state: throw so React Query retries it (with backoff), and never cache
      // or persist it.
      if (!providerListHasModels(providers)) {
        throw new Error(
          'opencode provider list has no connected models yet — sandbox still warming up',
        );
      }

      // Persist under the per-project scope (never the ephemeral per-sandbox
      // server id) so a fresh session paints the right models instantly. Only
      // genuine, model-bearing responses reach here, so the placeholder cache
      // is never poisoned with an empty list.
      setLSCache(LS_PROVIDERS, providers, nativeCacheScope);
      return providers;
    },
    // Only ever serve a model-bearing placeholder. A previously-poisoned cache
    // (written before this guard existed) is ignored so it can't paint empty.
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, nativeCacheScope);
      if (!providerListHasModels(cached)) return undefined;
      if (projectId) {
        const nativeProviders = filterToNativeProviders(cached as ProviderListResponse);
        return providerListHasModels(nativeProviders) ? nativeProviders : undefined;
      }
      return cached;
    },
    enabled: projectId
      ? projectModeKnown && !projectGatewayEnabled && runtimeReady
      : runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount) => failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });
  return projectId && projectGatewayEnabled ? gatewayProvidersQuery : nativeProvidersQuery;
}
