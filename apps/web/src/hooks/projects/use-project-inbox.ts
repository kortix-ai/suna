'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getProjectDetail } from '@kortix/sdk/projects-client';

import { getProjectInbox, markInboxRead, type InboxResponse } from '@/lib/inbox-client';

export function projectInboxKey(projectId: string | undefined) {
  return ['project-inbox', projectId] as const;
}

export function useInboxEnabled(projectId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  return data?.project?.experimental?.inbox ?? false;
}

export function useUnreadSessionIds(projectId: string | undefined, enabled = true): Set<string> {
  const { data } = useProjectInbox(projectId, enabled);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const item of data?.items ?? []) {
      if (!item.read && item.session_id) ids.add(item.session_id);
    }
    return ids;
  }, [data?.items]);
}

export function useProjectInbox(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: projectInboxKey(projectId),
    queryFn: () => getProjectInbox(projectId!),
    enabled: !!projectId && enabled,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
}

export function useMarkInboxRead(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (selection: { item_ids?: string[]; session_id?: string; all?: boolean }) =>
      markInboxRead(projectId!, selection),
    onSuccess: (result) => {
      queryClient.setQueryData<InboxResponse>(projectInboxKey(projectId), (prev) =>
        prev ? { ...prev, unread_count: result.unread_count } : prev,
      );
      queryClient.invalidateQueries({ queryKey: projectInboxKey(projectId) });
    },
  });
}
