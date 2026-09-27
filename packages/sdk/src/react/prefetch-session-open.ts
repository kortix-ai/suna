'use client';

import type { QueryClient } from '@tanstack/react-query';

import { openSessionBundle } from '../core/session/open-bundle';
import { readProjectSessionRow } from '../core/session/project-session-read';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * How long one prefetch of a session suppresses the next. Hover, focus and
 * touch all signal intent, and a pointer that crosses a sidebar row twice must
 * not pay for two snapshot reads. Sized like the session row's own freshness
 * contract: inside it, the row this prefetch seeded is still fresh.
 */
const PREFETCH_WINDOW_MS = 30_000;

const lastPrefetchAt = new Map<string, number>();

/** Tests only — a module singleton with no reset is a test that passes
 *  because of the one before it. Not exported from the package. */
export function resetSessionOpenPrefetches(): void {
  lastPrefetchAt.clear();
}

/**
 * Start a session's open read before the session view mounts: on intent to
 * open it (hover, focus, touch on a link), or as soon as a route names it.
 *
 * It issues the session-open snapshot (`GET .../snapshot`: the session row,
 * `/turn`, `/prompts` and the first transcript window in one request) and
 * seeds the session row cache from it. `useSession` and the hooks under it
 * claim that in-flight read instead of issuing their own, so nothing waits for
 * a mount to start the one request the first paint depends on.
 *
 * Read-only. It never calls `/start`, so it never provisions or wakes a
 * sandbox. Never rejects, and costs nothing when repeated for the same session
 * within {@link PREFETCH_WINDOW_MS}.
 */
export function prefetchSessionOpen(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): Promise<void> {
  if (!projectId || !sessionId) return Promise.resolve();
  const scope = `${projectId}/${sessionId}`;
  const nowMs = Date.now();
  const previous = lastPrefetchAt.get(scope);
  if (previous !== undefined && nowMs - previous < PREFETCH_WINDOW_MS) return Promise.resolve();
  lastPrefetchAt.set(scope, nowMs);

  openSessionBundle(projectId, sessionId);
  const queryKey = qk.project.session(projectId, sessionId);
  // `prefetchQuery` swallows errors and skips the read while a cached row is
  // fresh, on the same contract `useProjectSession` reads with.
  return queryClient.prefetchQuery({
    queryKey,
    queryFn: () =>
      readProjectSessionRow(projectId, sessionId, {
        bundle: queryClient.getQueryData(queryKey) === undefined,
      }),
    staleTime: contract('inventory').staleTime,
  });
}
