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
 *
 * The same `sessionsScope` prefix also holds every child of
 * `session(id, sessionId)`: `prompts`, `turn`, `messages` and `sandbox`. Those
 * are not session shapes. The prompts cache is an array, so a prefix-wide write
 * once put a `ProjectSession` in front of the prompt rows, and the next prompts
 * read threw on a row with no `prompt_id`. Both writers therefore match the
 * three keys above by name and nothing else under the prefix.
 */

import type { QueryClient, QueryFilters } from '@tanstack/react-query';
import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

export type ProjectSessionsUpdater = (sessions: ProjectSession[]) => ProjectSession[];

interface PagedSessionCache {
  pages: Array<{ items: ProjectSession[]; next_cursor: string | null }>;
  pageParams: unknown[];
}

// Read off the key factory rather than hand-typed, so the matcher moves with
// `qk` instead of silently missing a list after a segment is renamed.
const SESSIONS_SCOPE_LENGTH = qk.project.sessionsScope('').length;
const LIST_SEGMENTS: ReadonlySet<unknown> = new Set([
  qk.project.sessions('')[SESSIONS_SCOPE_LENGTH],
  qk.project.sessionsPaged('')[SESSIONS_SCOPE_LENGTH],
]);

/**
 * Query filters for the cache entries that hold session shapes, and only those:
 *
 *   [...sessionsScope(id), 'list', scope]         qk.project.sessions
 *   [...sessionsScope(id), 'list-paged', scope]   qk.project.sessionsPaged
 *   [...sessionsScope(id), sessionId]             qk.project.session
 *
 * A child of `session(id, sessionId)` has a segment after the session id, so it
 * never matches. A list key is matched by its family segment, not by its
 * length: the list keys are one segment longer than the row key.
 */
function sessionShapeFilters(projectId: string): QueryFilters {
  return {
    queryKey: qk.project.sessionsScope(projectId),
    predicate: ({ queryKey }) => {
      const tail = queryKey.slice(SESSIONS_SCOPE_LENGTH);
      if (tail.length === 1) return typeof tail[0] === 'string' && !LIST_SEGMENTS.has(tail[0]);
      return tail.length === 2 && LIST_SEGMENTS.has(tail[0]);
    },
  };
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

function updatedAtMs(row: ProjectSession): number | null {
  const ms = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether `incoming` may replace `cached`, the row already held for the same
 * session. It may not when both rows carry a parseable `updated_at` and the
 * incoming one is older. A row the server wrote earlier cannot describe the
 * session better than a row it wrote later: a warm-create row
 * (`provisioning`, stamped at insert) arriving after a read that shows the
 * session `running` would move the sidebar back to starting. Rows that cannot
 * be ordered are replaced, as before.
 */
function mayReplaceCachedRow(cached: ProjectSession, incoming: ProjectSession): boolean {
  const cachedMs = updatedAtMs(cached);
  const incomingMs = updatedAtMs(incoming);
  if (cachedMs === null || incomingMs === null) return true;
  return incomingMs >= cachedMs;
}

/**
 * Apply a sessions updater to ONE cache entry, whatever shape it holds.
 *
 * An unrecognized entry is returned BY REFERENCE, not rebuilt: handing
 * react-query a new object for one it did not need to change re-renders that
 * entry's observers for nothing.
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
 * `update` is a mapper over the rows already cached, so it applies no
 * `updated_at` ordering: what it returns is derived from those rows. Entries
 * under `sessionsScope` that are not session shapes (a session's prompts,
 * turn, messages, sandbox) are never passed to it.
 */
export function updateCachedProjectSessions(
  queryClient: QueryClient,
  projectId: string,
  update: ProjectSessionsUpdater,
): void {
  queryClient.setQueriesData(sessionShapeFilters(projectId), (cached: unknown) =>
    applyToCachedSessionShape(cached, update),
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
 *
 * A replace keeps the cached row when it is newer than `session` (see
 * `mayReplaceCachedRow`), and then returns `cached` by reference. An insert is
 * never refused: a list that does not hold the session has nothing to compare.
 */
export function upsertIntoCachedSessionShape(cached: unknown, session: ProjectSession): unknown {
  const upsert = (items: ProjectSession[]): ProjectSession[] => {
    const index = items.findIndex((row) => row.session_id === session.session_id);
    if (index === -1) return [session, ...items];
    if (!mayReplaceCachedRow(items[index], session)) return items;
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
    const page = cached.pages[target];
    if (!page) return cached;
    const items = upsert(page.items);
    if (items === page.items) return cached;
    return {
      ...cached,
      pages: cached.pages.map((existing, i) => (i === target ? { ...existing, items } : existing)),
    };
  }

  // The single-row entry only ever holds ONE session. It is replaced when it is
  // this session, and left alone otherwise — a different session's row is not a
  // list to insert into.
  if (isSessionRow(cached)) {
    return cached.session_id === session.session_id && mayReplaceCachedRow(cached, session)
      ? session
      : cached;
  }

  return cached;
}

/**
 * Insert a session into every cached list for this project, or replace it
 * wherever it is already cached. The optimistic counterpart of a create.
 * Never replaces a cached row with an older one, and never writes outside the
 * session list and session row entries.
 */
export function upsertCachedProjectSession(
  queryClient: QueryClient,
  projectId: string,
  session: ProjectSession,
): void {
  queryClient.setQueriesData(sessionShapeFilters(projectId), (cached: unknown) =>
    upsertIntoCachedSessionShape(cached, session),
  );
}
