'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { getProjectModelPicker } from '../core/rest/projects-client';
import { setProjectModelEnablement } from '../core/rest/projects-client/model-enablement';

export interface UseModelEnablement {
  /** Wire-model ids the project has turned OFF. */
  disabledModels: Set<string>;
  /** True unless the wire model is in the disabled set. */
  isEnabled: (wireModel: string) => boolean;
  /** Turn a wire model on/off and persist the new set to the server. */
  setEnabled: (wireModel: string, enabled: boolean) => Promise<void>;
  /** Re-enable every model (clear the disabled set). */
  enableAll: () => Promise<void>;
  isUpdating: boolean;
}

/**
 * Server-owned per-project model enablement (opt-out). Reads the disabled set
 * from the same `/model-picker` query `useProjectModels` uses, and persists
 * toggles via `PUT /projects/:id/model-enablement`. The gateway enforces the
 * set; this hook drives the "Manage models" switches and the picker's hiding.
 */
export function useModelEnablement(projectId: string | null | undefined): UseModelEnablement {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['project-model-picker', projectId], [projectId]);

  const { data } = useQuery({
    queryKey,
    queryFn: () => getProjectModelPicker(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: false,
  });

  const disabledModels = useMemo(
    () => new Set<string>((data?.disabledModels ?? []) as string[]),
    [data],
  );

  const mutation = useMutation({
    mutationFn: (next: string[]) => setProjectModelEnablement(projectId as string, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const setEnabled = useCallback(
    async (wireModel: string, enabled: boolean) => {
      const next = new Set(disabledModels);
      if (enabled) next.delete(wireModel);
      else next.add(wireModel);
      await mutation.mutateAsync([...next]);
    },
    [disabledModels, mutation],
  );

  const enableAll = useCallback(async () => {
    await mutation.mutateAsync([]);
  }, [mutation]);

  return {
    disabledModels,
    isEnabled: useCallback((wireModel: string) => !disabledModels.has(wireModel), [disabledModels]),
    setEnabled,
    enableAll,
    isUpdating: mutation.isPending,
  };
}
