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
 * A session row from any loaded session list of the project — paged or not,
 * either scope — or `undefined` when no loaded list holds it.
 *
 * Only the `'list'` family is read: `qk.project.session(id, sid)` is the
 * untrimmed detail read and is never a list.
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
    const rows = Array.isArray(data)
      ? (data as ProjectSession[])
      : isProjectSessionPagesData(data)
        ? data.pages.flatMap((page) => page.sessions)
        : [];
    const match = rows.find((session) => session.session_id === sessionId);
    if (match) return match;
  }
  return undefined;
}
