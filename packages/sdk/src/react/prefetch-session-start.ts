'use client';

import type { QueryClient } from '@tanstack/react-query';

import { sessionStartKey, startProjectSession } from '../core/rest/projects-client';

/**
 * Begin the session runtime boot DURING the route transition (before the session
 * page mounts), so provisioning overlaps navigation instead of starting after the
 * page paints. Idempotent + fire-and-forget: React Query dedupes against the
 * session page's own query (same key), and `/start` is idempotent server-side.
 * Also warms the route bundle. Use at every createProjectSession→navigate site.
 */
export function prefetchSessionStart(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): void {
  void queryClient.prefetchQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId),
    staleTime: 0,
  });
}
