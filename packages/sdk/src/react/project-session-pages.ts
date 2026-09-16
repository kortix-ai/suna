import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { ProjectSession, ProjectSessionPage } from '../core/rest/projects-client';

import { qk } from './query-keys';

/** The cache entry `useProjectSessionPages` owns. */
export type ProjectSessionPagesData = InfiniteData<ProjectSessionPage, string | null>;

/** True for a `useProjectSessionPages` cache entry (`{ pages, pageParams }`). */
export function isProjectSessionPagesData(data: unknown): data is ProjectSessionPagesData {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as { pages?: unknown }).pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams)
  );
}

/**
 * Every loaded session, in page order, each session once.
 *
 * Pages are keyset slices of a list that keeps moving: a session that becomes
 * active after page 1 was fetched returns on the refetched page 1 while an
 * older page still holds its previous copy. The first copy is the newest.
 */
export function flattenProjectSessionPages(
  data: ProjectSessionPagesData | undefined,
): ProjectSession[] {
  if (!data) return [];
  const seen = new Set<string>();
  const sessions: ProjectSession[] = [];
  for (const page of data.pages) {
    for (const session of page.sessions) {
      if (seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      sessions.push(session);
    }
  }
  return sessions;
}

/**
 * Apply a row transform to a cached session list, whichever shape it is.
 *
 * The `[...sessionsScope, 'list']` family holds bare arrays
 * (`qk.project.sessions`) and infinite data (`qk.project.sessionPages`).
 * A writer that only knows arrays silently skips paged lists. Anything that is
 * neither (a single row, `undefined`) passes through untouched.
 *
 * Returns the SAME reference when `mapRows` changed nothing, page by page, so
 * React Query's structural sharing does not re-render every list reader.
 */
export function mapProjectSessionListCache(
  data: unknown,
  mapRows: (rows: ProjectSession[]) => ProjectSession[],
): unknown {
  if (Array.isArray(data)) return mapRows(data as ProjectSession[]);
  if (!isProjectSessionPagesData(data)) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const sessions = mapRows(page.sessions);
    if (sessions === page.sessions) return page;
    changed = true;
    return { ...page, sessions };
  });
  return changed ? { ...data, pages } : data;
}

/**
 * Put one session into loaded pages: in place when a page holds it, otherwise
 * at the top of the first page.
 *
 * No pages loaded means no seed. A fabricated single page would carry
 * `next_cursor: null` and tell the list it has reached its end; the caller's
 * invalidation loads the real first page instead.
 */
export function upsertProjectSessionInPages(
  data: ProjectSessionPagesData | undefined,
  session: ProjectSession,
): ProjectSessionPagesData | undefined {
  if (!data || data.pages.length === 0) return data;
  const pageIndex = data.pages.findIndex((page) =>
    page.sessions.some((existing) => existing.session_id === session.session_id),
  );
  const pages = data.pages.slice();
  if (pageIndex === -1) {
    pages[0] = { ...pages[0]!, sessions: [session, ...pages[0]!.sessions] };
  } else {
    const page = pages[pageIndex]!;
    pages[pageIndex] = {
      ...page,
      sessions: page.sessions.map((existing) =>
        existing.session_id === session.session_id ? session : existing,
      ),
    };
  }
  return { ...data, pages };
}

/**
 * `refetchQueries` predicate for the session-list family: every entry except
 * infinite session lists. A TanStack infinite refetch re-requests every loaded
 * page (240 requests for a list scrolled 12,000 sessions deep); the list's
 * page-1 head query stays in the family and merges instead.
 */
export function skipInfiniteSessionLists(query: { state: { data: unknown } }): boolean {
  return !isProjectSessionPagesData(query.state.data);
}

/** `session_id` → row, built once per immutable cache value. */
const rowIndexByData = new WeakMap<object, Map<string, ProjectSession>>();

function rowIndex(data: unknown): Map<string, ProjectSession> | null {
  const isArray = Array.isArray(data);
  if (!isArray && !isProjectSessionPagesData(data)) return null;
  const cached = rowIndexByData.get(data as object);
  if (cached) return cached;
  const rows = isArray
    ? (data as ProjectSession[])
    : (data as ProjectSessionPagesData).pages.flatMap((page) => page.sessions);
  const index = new Map<string, ProjectSession>();
  for (const session of rows) {
    if (!index.has(session.session_id)) index.set(session.session_id, session);
  }
  rowIndexByData.set(data as object, index);
  return index;
}

/**
 * A session row from any loaded session list of the project — paged or not,
 * either scope — or `undefined` when no loaded list holds it.
 *
 * Only the `'list'` family is read: `qk.project.session(id, sid)` is the
 * untrimmed detail read and is never a list.
 *
 * Cache values are immutable, so each one is indexed once (a `WeakMap` keyed
 * by the value). A project with 12,000 loaded sessions answers every lookup in
 * O(1); `useProjectSessionRow` runs this on every query-cache event.
 */
export function findCachedProjectSession(
  queryClient: Pick<QueryClient, 'getQueriesData'>,
  projectId: string,
  sessionId: string,
): ProjectSession | undefined {
  const entries = queryClient.getQueriesData<unknown>({
    queryKey: [...qk.project.sessionsScope(projectId), 'list'],
  });
  for (const [, data] of entries) {
    const match = rowIndex(data)?.get(sessionId);
    if (match) return match;
  }
  return undefined;
}

/**
 * Fold a freshly fetched FIRST page (the head poll) into the loaded pages,
 * without refetching every loaded page.
 *
 * A TanStack infinite-query refetch re-requests every loaded page in order. A
 * list scrolled 240 pages deep would issue 240 requests per poll. Polling
 * exists to keep the newest sessions current (status, title, activity), and
 * those live on page 1, so only page 1 is fetched and merged:
 *
 * - One page loaded, or a head with no next cursor (the whole list fits):
 *   the head replaces the pages.
 * - Otherwise page 1 becomes the head rows, followed by the old page-1 rows
 *   that were pushed past the head's end by newer sessions. Old rows above the
 *   last row the head still contains, and absent from it, were deleted or
 *   hidden, and are dropped. Page 1 keeps its old `next_cursor`, so page 2
 *   still starts exactly where it did.
 * - No overlap at all (more new sessions than a page since the last poll):
 *   `'refetch'` — the caller refetches the pages instead of guessing.
 *
 * A session that moved up from a deeper page appears in the head and keeps a
 * stale copy below; `flattenProjectSessionPages` keeps the first copy.
 */
export function mergeProjectSessionHeadPage(
  data: ProjectSessionPagesData | undefined,
  head: ProjectSessionPage,
): ProjectSessionPagesData | 'refetch' | undefined {
  if (!data || data.pages.length === 0) return undefined;
  if (data.pages.length === 1 || head.next_cursor === null) {
    const [first] = data.pages;
    if (
      data.pages.length === 1 &&
      first!.next_cursor === head.next_cursor &&
      first!.sessions.length === head.sessions.length &&
      first!.sessions.every((session, index) => session === head.sessions[index])
    ) {
      return data;
    }
    return { pages: [head], pageParams: [null] };
  }
  const [first, ...rest] = data.pages;
  const headIds = new Set(head.sessions.map((session) => session.session_id));
  let lastShared = -1;
  first!.sessions.forEach((session, index) => {
    if (headIds.has(session.session_id)) lastShared = index;
  });
  if (lastShared === -1 && first!.sessions.length > 0) return 'refetch';
  const carried = first!.sessions.slice(lastShared + 1).filter((s) => !headIds.has(s.session_id));
  const sessions = [...head.sessions, ...carried];
  if (
    sessions.length === first!.sessions.length &&
    sessions.every((session, index) => session === first!.sessions[index])
  ) {
    return data;
  }
  return { ...data, pages: [{ ...first!, sessions }, ...rest] };
}
