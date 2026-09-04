'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getProjectModelPicker } from '../core/rest/projects-client';
import type { ProjectLlmCatalogResponse } from '../core/rest/projects-client';
import { type FlatModel, flattenModels } from './model-flatten';
import { projectLlmCatalogToProviderList } from './provider-selection';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { useProjectLlmGatewayEnabled } from './use-project-llm-gateway';

/**
 * Server-side model list for a project — the model parallel to
 * `useVisibleAgents({ projectId })`. Reads the compact, connection-aware picker
 * catalog (`GET /projects/:id/model-picker`) and flattens it to `FlatModel[]`
 * with correct provider/model ids. Works before any sandbox runtime exists and
 * avoids transferring or scanning the complete runtime models.dev catalog.
 */
/**
 * The raw `/model-picker` response for a project — the API's live catalog
 * record per wire model (`reasoning_options`, `temperature`, `limit`, …), for
 * a capability-gated control that needs more than the flattened list carries.
 * Same query key + fetcher as `useProjectModels`, so both read one cache
 * entry and one invalidation reaches both.
 */
export function useProjectModelPickerCatalog(
  projectId: string | null | undefined,
): ProjectLlmCatalogResponse | undefined {
  const gateway = useProjectLlmGatewayEnabled(projectId);
  const { data } = useQuery({
    queryKey: qk.project.modelPicker(projectId ?? ''),
    queryFn: () => getProjectModelPicker(projectId as string),
    enabled: !!projectId && gateway.enabled,
    ...contract('config'),
    retry: false,
  });
  return data;
}

export function useProjectModels(projectId: string | null | undefined): FlatModel[] {
  // `/model-picker` is a gateway route: with the project's llm_gateway flag
  // off it answers 404 llm_gateway_disabled — never fetch. Native projects
  // read models from the session runtime (`useOpenCodeProviders`).
  const gateway = useProjectLlmGatewayEnabled(projectId);
  const { data } = useQuery({
    // Shared with `useModelEnablement` (same fetcher) and the routing-policy
    // save's invalidation (`gateway-routing.tsx`) — all three must key on the
    // same `qk.project.modelPicker(id)` entry, or a toggle/save silently
    // fails to reach this reader (see that member's doc comment).
    queryKey: qk.project.modelPicker(projectId ?? ''),
    queryFn: () => getProjectModelPicker(projectId as string),
    enabled: !!projectId && gateway.enabled,
    ...contract('config'),
    retry: false,
  });
  return useMemo(() => (data ? flattenModels(projectLlmCatalogToProviderList(data)) : []), [data]);
}
