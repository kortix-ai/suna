'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import type { ProjectLlmCatalogResponse } from '../core/rest/projects-client';
import { getProjectModelPicker } from '../core/rest/projects-client';
import { setProjectModelEnablement } from '../core/rest/projects-client/model-enablement';

type ProjectModelPicker = ProjectLlmCatalogResponse;

export interface UseModelEnablement {
  /** True while the project has made no exceptions to the catalog default. */
  usingDefaults: boolean;
  /**
   * The model `auto` resolves to. It cannot be turned off, so render its switch
   * locked rather than letting the user click into a 409.
   */
  defaultModel: string | undefined;
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
    // Apply the new flags to the cached picker payload up front. Every surface
    // reads `enabled` off THIS query — the switch and the session picker both —
    // so without it the UI sits on the pre-toggle answer until the round trip
    // lands (and any picker that is currently unmounted keeps serving the stale
    // list when it remounts, which reads as "I had to hard refresh").
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProjectModelPicker>(queryKey);
      if (previous) {
        queryClient.setQueryData<ProjectModelPicker>(queryKey, {
          ...previous,
          models: Object.fromEntries(
            Object.entries(previous.models ?? {}).map(([id, model]) => [
              id,
              next[id] === undefined ? model : { ...model, enabled: next[id] },
            ]),
          ),
          modelOverrides: next,
          usingDefaults: Object.keys(next).length === 0,
        });
      }
      return { previous };
    },
    // A rejected write (e.g. 409 on the project default) must not leave the UI
    // showing a state the server refused.
    onError: (_err, _next, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    // `refetchType: 'all'` so an unmounted picker's cache is refreshed too, not
    // just marked stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey, refetchType: 'all' }),
  });

  // The stored exceptions, served alongside the resolved flags so a toggle is
  // a merge into what's already there rather than a fresh full set.
  const overrides = useMemo(() => data?.modelOverrides ?? {}, [data]);

  return {
    usingDefaults: data?.usingDefaults ?? true,
    defaultModel: data?.defaultModel,
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
