/**
 * persisted-queries — which queries survive an app restart, how they come
 * back, and how long they stay in memory: the settings of the SDK's
 * `createPersistedQueryCache` (`QUERY_CACHE_OPTIONS`, wired in
 * `lib/query/query-cache.ts`).
 *
 * The SDK's `isPersistableQueryKey` covers the SDK's `['kx', …]` keys. This app
 * has its own keys (`projectKeys`, lib/projects/hooks.ts). Kept: what a user
 * navigates by, small and not sensitive —
 *
 *   ['accounts']                              the account list
 *   ['projects', accountId]                   one account's projects
 *   ['project', projectId]                    the project row (name, account)
 *   ['project-sessions', projectId, 'paged']  the drawer's and the Sessions page's list
 *
 * Not kept: transcripts, secrets, files, the flat first page
 * (`['project-sessions', projectId]`, a lookup copy of page one), and the
 * config summary (`['project-detail', projectId]`): its `files` field is the
 * repository's whole file listing, unbounded in size.
 *
 * Pure: `bun test` cannot load native modules.
 */

import { PERSISTED_QUERY_CACHE_VERSION } from '@kortix/sdk';

/**
 * The stored cache's version: the SDK's part changes with the SDK's data
 * shapes, the second part with this app's (bump it when a kept query's data
 * changes shape — the stored cache is then discarded, never migrated).
 */
export const QUERY_CACHE_VERSION = `${PERSISTED_QUERY_CACHE_VERSION}.1`;

/**
 * Upper bound of the stored cache, in UTF-16 code units: at most ~1.5 MB of
 * UTF-8 on disk. Android's AsyncStorage is one SQLite database of 6 MB for the
 * whole app (the supabase session included), and it cannot read a value
 * larger than its 2 MB cursor window. The SDK's 1,000,000 default is sized for
 * a browser's localStorage.
 */
export const QUERY_CACHE_MAX_BYTES = 500_000;

/**
 * How long a kept query stays in memory without a screen reading it (default
 * 5 minutes). A restored list must outlive the time until its screen mounts: a
 * project the user switches to later, the switcher's project list. The gc
 * also decides what is stored, since a collected query leaves the next write.
 */
export const PERSISTED_QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * The key prefixes of the kept families, for `setQueryDefaults` (a prefix
 * match). `['project-sessions']` also reaches the flat first page: one page,
 * so its longer life costs little.
 */
export const PERSISTED_QUERY_FAMILIES: readonly (readonly [string])[] = [
  ['accounts'],
  ['projects'],
  ['project'],
  ['project-sessions'],
];

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPagedSessionsKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey.length === 3 &&
    queryKey[0] === 'project-sessions' &&
    isId(queryKey[1]) &&
    queryKey[2] === 'paged'
  );
}

/** The `shouldPersist` predicate: true only for the four keys above. */
export function isPersistedQueryKey(queryKey: readonly unknown[]): boolean {
  const [family, id] = queryKey;
  switch (family) {
    case 'accounts':
      return queryKey.length === 1;
    case 'projects':
    case 'project':
      return queryKey.length === 2 && isId(id);
    case 'project-sessions':
      return isPagedSessionsKey(queryKey);
    default:
      return false;
  }
}

/** The slice of a TanStack `QueryClient` the restore trim reads and writes. */
export interface RestoredQueriesTarget {
  getQueryCache(): {
    getAll(): readonly {
      queryKey: readonly unknown[];
      state: { data: unknown; dataUpdatedAt: number };
    }[];
  };
  setQueryData(
    queryKey: readonly unknown[],
    data: unknown,
    options?: { updatedAt?: number }
  ): unknown;
}

/**
 * After a restore, each paged session list keeps its first page only, at its
 * original age. A restored list refetches every page it holds when its screen
 * mounts, one request after another, and shows no fresh row until the last
 * page answers: a filter that walked 10 pages in the last run would cost 10
 * requests on the next start. Page one is what the first frame shows; a
 * scroll loads the rest again.
 */
export function keepFirstSessionPage(client: RestoredQueriesTarget): void {
  for (const query of client.getQueryCache().getAll()) {
    if (!isPagedSessionsKey(query.queryKey)) continue;
    const data = query.state.data as { pages?: unknown; pageParams?: unknown } | undefined;
    if (!data || !Array.isArray(data.pages) || !Array.isArray(data.pageParams)) continue;
    if (data.pages.length <= 1) continue;
    client.setQueryData(
      query.queryKey,
      { ...data, pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
      { updatedAt: query.state.dataUpdatedAt }
    );
  }
}

/** A write serializes every kept query: coalesce a poll burst into one write. */
export const QUERY_CACHE_THROTTLE_MS = 2_000;

/**
 * The app's persisted cache settings, all but the storage
 * (lib/query/query-cache.ts). Tests build their binder from the same object.
 */
export const QUERY_CACHE_OPTIONS = {
  shouldPersist: isPersistedQueryKey,
  // A restored session list refetches one page on mount, not every page.
  afterRestore: keepFirstSessionPage,
  version: QUERY_CACHE_VERSION,
  maxBytes: QUERY_CACHE_MAX_BYTES,
  throttleMs: QUERY_CACHE_THROTTLE_MS,
};

/** The slice of a TanStack `QueryClient` the defaults need. */
export interface QueryDefaultsTarget {
  setQueryDefaults(queryKey: readonly unknown[], options: { gcTime: number }): void;
}

/**
 * Give the kept families their longer gc time. Call once, on the new client,
 * before a restore: a restored entry takes its gc time from these defaults.
 */
export function applyPersistedQueryDefaults(client: QueryDefaultsTarget): void {
  for (const family of PERSISTED_QUERY_FAMILIES) {
    client.setQueryDefaults(family, { gcTime: PERSISTED_QUERY_GC_TIME_MS });
  }
}
