'use client';

import { ensureWarmProjectSession } from '@kortix/sdk';
import { prefetchSessionStart } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

export const warmProjectSessionKey = (projectId: string) =>
  ['project-warm-session', projectId] as const;

export function useWarmProjectSession(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: warmProjectSessionKey(projectId ?? ''),
    queryFn: () => ensureWarmProjectSession(projectId!),
    enabled: !!projectId,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const sessionId = query.data?.session.session_id;
  useEffect(() => {
    if (!projectId || !sessionId) return;
    prefetchSessionStart(queryClient, projectId, sessionId);
  }, [projectId, queryClient, sessionId]);

  const resolveSession = useCallback(async () => {
    if (!projectId) return undefined;
    const result = await queryClient.fetchQuery({
      queryKey: warmProjectSessionKey(projectId),
      queryFn: () => ensureWarmProjectSession(projectId),
      staleTime: 10_000,
      retry: false,
    });
    return result.session;
  }, [projectId, queryClient]);

  return { ...query, resolveSession };
}
