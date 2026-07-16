'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getProjectModelPicker } from '../core/rest/projects-client';
import { type FlatModel, flattenModels } from './model-flatten';
import { projectLlmCatalogToProviderList } from './provider-selection';

/**
 * Server-side model list for a project — the model parallel to
 * `useVisibleAgents({ projectId })`. Reads the compact, connection-aware picker
 * catalog (`GET /projects/:id/model-picker`) and flattens it to `FlatModel[]`
 * with correct provider/model ids. Works before any sandbox runtime exists and
 * avoids transferring or scanning the complete runtime models.dev catalog.
 */
export function useProjectModels(projectId: string | null | undefined): FlatModel[] {
  const { data } = useQuery({
    queryKey: ['project-model-picker', projectId],
    queryFn: () => getProjectModelPicker(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: false,
  });
  return useMemo(() => (data ? flattenModels(projectLlmCatalogToProviderList(data)) : []), [data]);
}
