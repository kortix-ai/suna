'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { listProjectSessions, sessionStartKey } from '@kortix/sdk/projects-client';
import { runningSessionWarmupTargets } from './session-cache-warmer-targets';

/**
 * Seeds known-running ACP session readiness.
 * The active route owns the live ACP connection and transcript synchronization.
 */
export function SessionCacheWarmer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;
  const { data: sessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const targets = useMemo(
    () => runningSessionWarmupTargets(sessions ?? [], activeSessionId),
    [activeSessionId, sessions],
  );

  useEffect(() => {
    for (const target of targets) {
      const key = sessionStartKey(projectId, target.sessionId);
      if (queryClient.getQueryData(key) == null) queryClient.setQueryData(key, target.startSeed);
    }
  }, [projectId, queryClient, targets]);

  return null;
}
