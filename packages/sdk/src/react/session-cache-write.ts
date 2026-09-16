/**
 * Writing to the project-session caches, whatever shape they are in.
 *
 * One project's sessions are cached under three different shapes at once:
 *
 *   qk.project.sessions(id, scope)        →  ProjectSession[]
 *   qk.project.sessionsPaged(id, scope)   →  { pages: ProjectSessionPage[], pageParams }
 *   qk.project.session(id, sessionId)     →  ProjectSession
 *
 * A mutation's optimistic write used to know only the first one, because it was
 * the only one: the sidebar held the project's entire session list in a single
 * flat array. Once that list became a bounded `useInfiniteQuery`
 * (`useProjectSessions`), a write aimed at the flat key stopped reaching the
 * surface the user was looking at — the rename appeared only when the
 * post-mutation refetch landed, which is exactly the delay the optimistic write
 * exists to hide.
 *
 * `updateCachedProjectSessions` writes through all three, so a caller states
 * the change once, in terms of sessions, and never names a cache shape.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

export type ProjectSessionsUpdater = (sessions: ProjectSession[]) => ProjectSession[];

interface PagedSessionCache {
  pages: Array<{ items: ProjectSession[]; next_cursor: string | null }>;
  pageParams: unknown[];
}

function isPagedSessionCache(value: unknown): value is PagedSessionCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as PagedSessionCache).pages)
  );
}

function isSessionRow(value: unknown): value is ProjectSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProjectSession).session_id === 'string'
  );
}

/**
 * Apply a sessions updater to ONE cache entry, whatever shape it holds.
 *
 * An unrecognized entry is returned BY REFERENCE, not rebuilt: every entry
 * under the sessions prefix passes through here, and handing react-query a new
 * object for one it did not need to change re-renders that entry's observers
 * for nothing.
 */
export function applyToCachedSessionShape(cached: unknown, update: ProjectSessionsUpdater): unknown {
  if (Array.isArray(cached)) return update(cached as ProjectSession[]);

  if (isPagedSessionCache(cached)) {
    return {
      ...cached,
      pages: cached.pages.map((page) => ({ ...page, items: update(page.items) })),
    };
  }

  if (isSessionRow(cached)) {
    // A single row is a one-element list as far as the updater is concerned.
    // An updater that drops it (a delete) leaves the entry untouched rather
    // than caching `undefined`, which react-query reads as "never fetched".
    const [updated] = update([cached]);
    return updated ?? cached;
  }

  return cached;
}

/**
 * Apply `update` to every cached session list for this project — flat, paged,
 * single-row, and every scope — in one call.
 *
 * Prefixed on `qk.project.sessionsScope(projectId)`, the same prefix every
 * mutation already invalidates, so a cache shape added later is covered without
 * finding each writer again.
 */
export function updateCachedProjectSessions(
  queryClient: QueryClient,
  projectId: string,
  update: ProjectSessionsUpdater,
): void {
  queryClient.setQueriesData(
    { queryKey: qk.project.sessionsScope(projectId) },
    (cached: unknown) => applyToCachedSessionShape(cached, update),
  );
}
