'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import {
  listProjectSessions,
  projectSessionStartSeed,
  sessionStartKey,
} from '@kortix/sdk/projects-client';
import { prefetchSession } from '@kortix/sdk/react';
import { runningSessionWarmupTargets } from './session-cache-warmer-targets';

/**
 * Seeds known-running session readiness and fetches one bounded message tail.
 * The active route owns the only live SSE stream and revalidates its cached tail.
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
    for (const session of sessions ?? []) {
      const seed = projectSessionStartSeed(session);
      if (!seed) continue;
      const key = sessionStartKey(projectId, session.session_id);
      if (queryClient.getQueryData(key) == null) queryClient.setQueryData(key, seed);
    }
    for (const target of targets) {
      void prefetchSession(target.openCodeSessionId, target.runtimeUrl);
    }
  }, [projectId, queryClient, sessions, targets]);

  return null;
}
