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

const key = (workspaceId: string | null) => ['channels', 'bindings', workspaceId ?? 'none'] as const;

export function useChannelBindings(workspaceId: string | null) {
  return useQuery({
    queryKey: key(workspaceId),
    enabled: !!workspaceId,
    staleTime: 15_000,
    queryFn: () => (workspaceId ? listChannelBindings(workspaceId) : null),
  });
}

export function useUpdateChannelBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      bindingId,
      ...input
    }: { workspaceId: string; bindingId: string } & UpdateChannelBindingInput) =>
      updateChannelBinding(workspaceId, bindingId, input),
    onSuccess: (_data, { workspaceId }) => {
      qc.invalidateQueries({ queryKey: key(workspaceId) });
    },
  });
}
