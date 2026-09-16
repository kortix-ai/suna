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
    // Matched back BY ID, not by position: an updater that prepends (a session
    // being seeded) would otherwise replace this entry with the new session's
    // row, so `session(projectId, sessionId)` would start answering with a
    // DIFFERENT session. An updater that drops the row (a delete) leaves the
    // entry untouched rather than caching `undefined`, which react-query reads
    // as "never fetched".
    const updated = update([cached]);
    return updated.find((row) => row.session_id === cached.session_id) ?? cached;
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

/**
 * Insert a session at the top of the cached lists, or replace it where it is
 * already cached.
 *
 * Separate from `updateCachedProjectSessions` because an INSERT is not a map:
 * running a prepending updater over a paged cache would add the row to every
 * loaded page. The list is ordered by most recent activity, so a just-created
 * session belongs at the top of the FIRST page and nowhere else.
 */
export function upsertIntoCachedSessionShape(cached: unknown, session: ProjectSession): unknown {
  const upsert = (items: ProjectSession[]): ProjectSession[] => {
    const index = items.findIndex((row) => row.session_id === session.session_id);
    if (index === -1) return [session, ...items];
    const next = items.slice();
    next[index] = session;
    return next;
  };

  if (Array.isArray(cached)) return upsert(cached as ProjectSession[]);

  if (isPagedSessionCache(cached)) {
    const index = cached.pages.findIndex((page) =>
      page.items.some((row) => row.session_id === session.session_id),
    );
    // Already loaded on some page: replace it there, in place. Only a session
    // the cache has never seen is prepended, and only to page one.
    const target = index === -1 ? 0 : index;
    return {
      ...cached,
      pages: cached.pages.map((page, i) =>
        i === target ? { ...page, items: upsert(page.items) } : page,
      ),
    };
  }

  // The single-row entry only ever holds ONE session. It is replaced when it is
  // this session, and left alone otherwise — a different session's row is not a
  // list to insert into.
  if (isSessionRow(cached)) {
    return cached.session_id === session.session_id ? session : cached;
  }

  return cached;
}

/**
 * Insert a session into every cached list for this project, or replace it
 * wherever it is already cached. The optimistic counterpart of a create.
 */
export function upsertCachedProjectSession(
  queryClient: QueryClient,
  projectId: string,
  session: ProjectSession,
): void {
  queryClient.setQueriesData(
    { queryKey: qk.project.sessionsScope(projectId) },
    (cached: unknown) => upsertIntoCachedSessionShape(cached, session),
  );
}
