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

import type { Query, QueryClient } from '@tanstack/react-query';
import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

/**
 * Is this cache entry one of the three SESSION shapes above?
 *
 * The `sessionsScope(projectId)` prefix is not only sessions. `sessionPrompts`,
 * `messages`, `sessionTurn` and `sessionSandbox` nest under
 * `session(projectId, sessionId)`, and two of them are arrays. A prefix write
 * treated the prompt inbox as a session list: starting a session put a
 * `ProjectSession` into every cached inbox, and the composer of any session
 * still in memory threw on render and could not send (prod, 2026-09-22).
 *
 * Keys, relative to the prefix: `['list', scope]`, `['list-paged', scope]`,
 * and `[sessionId]`. Anything longer or different is not a session.
 */
function isSessionCacheKey(projectId: string, query: Query): boolean {
  const prefix = qk.project.sessionsScope(projectId);
  const rest = query.queryKey.slice(prefix.length);
  if (rest.length === 2) return rest[0] === 'list' || rest[0] === 'list-paged';
  return rest.length === 1 && typeof rest[0] === 'string';
}

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
 * Prefixed on `qk.project.sessionsScope(projectId)` and narrowed to the session
 * shapes by `isSessionCacheKey`: the prefix also holds each session's prompts,
 * messages and turn, which are not sessions.
 */
export function updateCachedProjectSessions(
  queryClient: QueryClient,
  projectId: string,
  update: ProjectSessionsUpdater,
): void {
  queryClient.setQueriesData(
    {
      queryKey: qk.project.sessionsScope(projectId),
      predicate: (query) => isSessionCacheKey(projectId, query),
    },
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
    {
      queryKey: qk.project.sessionsScope(projectId),
      predicate: (query) => isSessionCacheKey(projectId, query),
    },
    (cached: unknown) => upsertIntoCachedSessionShape(cached, session),
  );
}
