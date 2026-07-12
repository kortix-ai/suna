'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getProjectLlmCatalog } from '../core/rest/projects-client';
import { type FlatModel, flattenModels } from './model-flatten';
import { projectLlmCatalogToProviderList } from './provider-selection';

/**
 * Server-side model list for a project — the model parallel to
 * `useVisibleAgents({ projectId })`. Reads the project's gateway catalog
 * (`GET /projects/:id/llm-catalog`) and flattens it to `FlatModel[]` with correct
 * provider/model ids. Works BEFORE any sandbox runtime exists, so a "new session"
 * screen can show + pre-select a model, and the in-session picker shares the same
 * source — no runtime round-trip, no gateway-vs-BYOK key guessing.
 */
export function useProjectModels(projectId: string | null | undefined): FlatModel[] {
  const { data } = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => getProjectLlmCatalog(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: false,
  });
  return useMemo(() => (data ? flattenModels(projectLlmCatalogToProviderList(data)) : []), [data]);
}
