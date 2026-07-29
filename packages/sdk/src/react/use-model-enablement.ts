'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { getProjectModelPicker } from '../core/rest/projects-client';
import { setProjectModelEnablement } from '../core/rest/projects-client/model-enablement';

export interface UseModelEnablement {
  /** True while the project has made no exceptions to the catalog default. */
  usingDefaults: boolean;
  /** Pin a wire model on/off, as an exception to the default. */
  setEnabled: (wireModel: string, enabled: boolean) => Promise<void>;
  /** Drop every exception so the catalog default applies again. */
  resetToDefaults: () => Promise<void>;
  isUpdating: boolean;
}

/**
 * Server-owned per-project model enablement. Every model served by
 * `/model-picker` already carries its own resolved `enabled` flag — read THAT
 * to render a switch or filter a list. This hook only handles the writes.
 *
 * Writes are EXCEPTIONS, never the resolved set: a project that pins its whole
 * list would stop tracking "the latest", and every future model would arrive
 * switched off.
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

  const mutation = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      setProjectModelEnablement(projectId as string, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  // The stored exceptions, served alongside the resolved flags so a toggle is
  // a merge into what's already there rather than a fresh full set.
  const overrides = useMemo(() => data?.modelOverrides ?? {}, [data]);

  return {
    usingDefaults: data?.usingDefaults ?? true,
    setEnabled: useCallback(
      async (wireModel: string, enabled: boolean) => {
        await mutation.mutateAsync({ ...overrides, [wireModel]: enabled });
      },
      [overrides, mutation],
    ),
    resetToDefaults: useCallback(async () => {
      await mutation.mutateAsync({});
    }, [mutation]),
    isUpdating: mutation.isPending,
  };
}
