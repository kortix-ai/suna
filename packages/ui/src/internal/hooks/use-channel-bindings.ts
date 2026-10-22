'use client';

import {
  listChannelBindings,
  updateChannelBinding,
  type ChannelBinding,
  type ChannelBindingsResponse,
  type UpdateChannelBindingInput,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type { ChannelBinding, ChannelBindingsResponse, UpdateChannelBindingInput };

const key = (projectId: string | null) => ['channels', 'bindings', projectId ?? 'none'] as const;

export function useChannelBindings(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 15_000,
    queryFn: () => (projectId ? listChannelBindings(projectId) : null),
  });
}

export function useUpdateChannelBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      bindingId,
      ...input
    }: { projectId: string; bindingId: string } & UpdateChannelBindingInput) =>
      updateChannelBinding(projectId, bindingId, input),
    // Settled, not success: the route applies agent, model, then policy, so a
    // refused model can follow a saved agent change.
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
    // The caller toasts its own error. Without this no-op the QueryClient's
    // default mutation `onError` (react-query-provider.tsx) adds a second,
    // generic "Failed to perform action: …" toast.
    onError: () => {},
  });
}
