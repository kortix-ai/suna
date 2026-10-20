'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { useKortixRouteProjectId } from '../route-project';
import { contract } from '../query-contracts';
import { qk } from '../query-keys';
import { runtimeKeys, useRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap } from './shared';
import { getProjectModelPicker } from '../../core/rest/projects-client';
import {
  GATEWAY_PROVIDER_IDS,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasModels,
} from '../../core/models/provider-selection';

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

/**
 * The composer's provider list. On a project route: the project's gateway
 * catalog (`GET /projects/:id/model-picker`) as the single `kortix` provider —
 * the LLM gateway is the only model path. Off a project route: the session
 * runtime's own `/provider` list.
 */
export function useRuntimeProviders() {
  const queryClient = useQueryClient();
  const runtimeReady = useRuntimeReady();
  const projectId = useKortixRouteProjectId();
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
    enabled: !!projectId,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: (failureCount, error) => !isClientError(error) && failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  const runtimeProvidersQuery = useQuery<ProviderListResponse>({
    queryKey: runtimeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      const providers = normalizeProviderList(unwrap(result));
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
    enabled: !projectId && runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount, error) => !isClientError(error) && failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });

  return projectId ? gatewayProvidersQuery : runtimeProvidersQuery;
}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `useRuntimeProviders`. Removed in the next major. */
export const useOpenCodeProviders = useRuntimeProviders;
