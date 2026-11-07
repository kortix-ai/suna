'use client';

import type { QueryClient } from '@tanstack/react-query';

import { sessionStartKey, startWorkspaceSession } from '../core/rest/projects-client';

/**
 * Begin the session runtime boot DURING the route transition (before the session
 * page mounts), so provisioning overlaps navigation instead of starting after the
 * page paints. Idempotent: React Query dedupes against the session page's own
 * query (same key), and `/start` is idempotent server-side. Also warms the route
 * bundle. Use at every createProjectSession→navigate site.
 *
 * Returns the prefetch promise (it never rejects — `prefetchQuery` swallows
 * errors) so a caller can sequence work on `/start` having settled.
 * Fire-and-forget callers just ignore the return.
 */
export function prefetchSessionStart(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startWorkspaceSession(projectId, sessionId),
    staleTime: 0,
  });
}
