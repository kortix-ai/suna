'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getWorkspaceModelPicker } from '../core/rest/workspaces-client';
import { type FlatModel, flattenModels } from './model-flatten';
import { workspaceLlmCatalogToProviderList } from './provider-selection';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Server-side model list for a workspace — the model parallel to
 * `useVisibleAgents({ workspaceId })`. Reads the compact, connection-aware picker
 * catalog (`GET /workspaces/:id/model-picker`) and flattens it to `FlatModel[]`
 * with correct provider/model ids. Works before any sandbox runtime exists and
 * avoids transferring or scanning the complete runtime models.dev catalog.
 */
export function useWorkspaceModels(workspaceId: string | null | undefined): FlatModel[] {
  const { data } = useQuery({
    // Shared with `useModelEnablement` (same fetcher) and the routing-policy
    // save's invalidation (`gateway-routing.tsx`) — all three must key on the
    // same `qk.workspace.modelPicker(id)` entry, or a toggle/save silently
    // fails to reach this reader (see that member's doc comment).
    queryKey: qk.workspace.modelPicker(workspaceId ?? ''),
    queryFn: () => getWorkspaceModelPicker(workspaceId as string),
    enabled: !!workspaceId,
    ...contract('config'),
    retry: false,
  });
  return useMemo(() => (data ? flattenModels(workspaceLlmCatalogToProviderList(data)) : []), [data]);
}

/** @deprecated Use `useWorkspaceModels`. */
export const useProjectModels = useWorkspaceModels;
