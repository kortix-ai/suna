'use client';

import type { QueryClient } from '@tanstack/react-query';

import { claimOpenBundle, openSessionBundle } from '../core/session/open-bundle';
import { getModelDefaults } from '../core/rest/projects-client/model-defaults';
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
const PREFETCH_LEDGER_PRUNE_AT = 200;

/** Tests only. Not exported from the package. */
export function prefetchedSessionCount(): number {
  return lastPrefetchAt.size;
}

/** Tests only — a module singleton with no reset is a test that passes
 *  because of the one before it. Not exported from the package. */
export function resetSessionOpenPrefetches(): void {
  lastPrefetchAt.clear();
}

/**
 * Start a session's open read before the session view mounts: on intent to
 * open it (hover, focus, touch on a link), or as soon as a route names it.
 *
 * It issues the session-open snapshot (`GET .../snapshot?transcript=0`: the
 * session row, `/turn` and `/prompts` in one request; no v1 transcript window,
 * because the open reads the session log first) and
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
  // An entry past its window suppresses nothing: drop it, so a long-lived
  // window that hovers thousands of sessions does not grow this forever.
  if (lastPrefetchAt.size >= PREFETCH_LEDGER_PRUNE_AT) {
    for (const [key, at] of lastPrefetchAt) {
      if (nowMs - at >= PREFETCH_WINDOW_MS) lastPrefetchAt.delete(key);
    }
  }
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

/**
 * Hand the session-open snapshot's `models` leg (= `GET .../model-defaults`)
 * to the model-defaults query. The seed is the query's own fetch, started
 * from `useSession`'s layout effect: `useModelDefaults` mounts onto it and
 * issues no `/model-defaults` request of its own. A leg that is not `known`
 * (a failed read) falls back to the route.
 *
 * Seeds only an empty or stale entry, as every snapshot leg does: a read
 * issued after a change asks the route.
 *
 * Internal: not exported from any public entry point.
 */
export function seedModelDefaultsFromOpenBundle(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): void {
  const bundle = claimOpenBundle(projectId, sessionId);
  if (!bundle) return;
  void queryClient.prefetchQuery({
    queryKey: ['model-defaults', projectId],
    queryFn: async () => {
      const models = (await bundle)?.models;
      if (!models?.known) return getModelDefaults(projectId);
      const { known: _known, ...defaults } = models;
      return defaults;
    },
    // `useModelDefaults`' own freshness: inside it the seed is the answer.
    staleTime: 30_000,
  });
}
