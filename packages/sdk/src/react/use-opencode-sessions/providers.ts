'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { useKortixRouteProjectId } from '../route-project';
import { contract } from '../query-contracts';
import { qk } from '../query-keys';
import { runtimeKeys, useRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap } from './shared';
import {
  getProjectDetail,
  getProjectLlmCatalogProviders,
  getProjectModelPicker,
  listProjectSecrets,
} from '../../core/rest/projects-client';
import {
  GATEWAY_PROVIDER_IDS,
  mergeNativeProviderLists,
  nativeProviderListFromCatalog,
  nativeRuntimeProviderList,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasModels,
} from '../../core/models/provider-selection';
import { shouldLoadProjectModelPicker } from './provider-load-plan';

// ============================================================================
// Provider Hooks
// ============================================================================

export { GATEWAY_PROVIDER_IDS };

/**
 * A 4xx answer (401 dead token, 403 denied, 404 missing route) is permanent
 * for this request: retrying it replays the failure and warns on the API every
 * attempt (prod: 11 `GET /projects/:id/model-picker` warn lines in 65 s from
 * `retry: 10`). Only transport failures and 5xx deserve the boot-race backoff.
 */
function isClientError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function useRuntimeProviders() {
  const queryClient = useQueryClient();
  const runtimeReady = useRuntimeReady();
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
      return projectLlmCatalogToProviderList(catalog);
    },
    enabled: shouldLoadProjectModelPicker({
      projectId,
      projectModeKnown,
      projectGatewayEnabled,
    }),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount, error) =>
      (!projectModeKnown || projectGatewayEnabled) && !isClientError(error) && failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  // BYOK makes the connected model set project-specific. A provider connected
  // in one project must not leak into another or remain after removal.
  const nativeProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: projectId ? ['project-providers', projectId, 'native'] : runtimeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      let providers = normalizeProviderList(unwrap(result));
      if (projectId) {
        const secrets = await listProjectSecrets(projectId);
        const items = Array.isArray(secrets) ? secrets : (secrets.items ?? []);
        const secretNames = new Set(items.map((secret: { name: string }) => secret.name));
        // The same transform `pickerProviderList` applies (framework-free core).
        providers = nativeRuntimeProviderList(providers, secretNames);
      }

      // During sandbox boot the OpenCode server frequently answers
      // /provider/list BEFORE its provider config is wired up, returning zero
      // CONNECTED providers (→ zero models). With staleTime:Infinity such an
      // empty answer would be cached for the whole session and never refetched.
      // That is the "model picker never shows up" bug. Treat a model-less
      // response as a transient boot state: throw so React Query retries it
      // (with backoff), and never cache it.
      if (!providerListHasModels(providers)) {
        throw new Error(
          'opencode provider list has no connected models yet — sandbox still warming up',
        );
      }
      return providers;
    },
    enabled: projectId
      ? projectModeKnown && !projectGatewayEnabled && runtimeReady
      : runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount, error) => !isClientError(error) && failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });
  // Native mode, BEFORE the session runtime exists (project home, cold
  // session): opencode's /provider list — the native query's only source —
  // cannot be read yet, so without a fallback the composer showed "No models
  // available" until a sandbox booted, and connecting a key changed nothing.
  // Synthesize the picker source from the ungated /llm-catalog/providers
  // route + the project's secret names (nativeProviderListFromCatalog). The
  // live runtime list takes over the moment it exists; a cached runtime
  // answer (the native query's placeholderData) also wins, since it is
  // runtime truth from a previous boot.
  const nativeCatalogQuery = useQuery<ProviderListResponse>({
    queryKey: ['project-providers', projectId, 'native-catalog'],
    queryFn: async () => {
      const [catalog, secrets] = await Promise.all([
        getProjectLlmCatalogProviders(projectId!),
        // `project.secret.read` is manager-tier: a member's read 403s. Treat
        // that as "no keys visible" — the runtime list corrects it on boot —
        // rather than erroring the whole picker source.
        listProjectSecrets(projectId!).catch(() => ({ items: [] as Array<{ name: string }> })),
      ]);
      const items = Array.isArray(secrets) ? secrets : (secrets.items ?? []);
      return nativeProviderListFromCatalog(
        catalog,
        new Set(items.map((secret: { name: string }) => secret.name)),
      );
    },
    // Stays live after boot: the merged picker keeps catalog order + curated
    // defaults under the runtime's provider objects (see
    // `mergeNativeProviderLists`), so the list does not change under the user
    // the moment the sandbox reports in.
    enabled: !!projectId && projectModeKnown && !projectGatewayEnabled,
    ...contract('config'),
    retry: false,
  });

  const mergedNative = useMemo(
    () => mergeNativeProviderLists(nativeCatalogQuery.data, nativeProvidersQuery.data),
    [nativeCatalogQuery.data, nativeProvidersQuery.data],
  );

  if (projectId && projectGatewayEnabled) return gatewayProvidersQuery;
  if (projectId && projectModeKnown && !projectGatewayEnabled) {
    // ONE native picker across sandbox states. `isLoading` follows whichever
    // source is still the only one expected right now: pre-boot the catalog,
    // post-boot the runtime.
    const base = runtimeReady || nativeProvidersQuery.data ? nativeProvidersQuery : nativeCatalogQuery;
    return Object.assign({}, base, { data: mergedNative }) as typeof nativeProvidersQuery;
  }
  return nativeProvidersQuery;
}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `useRuntimeProviders`. Removed in the next major. */
export const useOpenCodeProviders = useRuntimeProviders;
