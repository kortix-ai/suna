'use client';

import { listDiscoverConnectors, listPipedreamApps } from '@kortix/sdk';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  type CatalogEntry,
  type CatalogSource,
} from './catalog-entry';
import {
  CATALOG_AUTOLOAD_MAX_PAGES,
  CATALOG_FOCUS_TARGET,
  CATALOG_INITIAL_PAGES,
  shouldAutoLoadPage,
} from './catalog-paging';
import { countInSection } from './connector-categories';

export interface CatalogState {
  /** Every page loaded so far, normalised and flattened. Grows as the user
   *  scrolls — this is not a single page. */
  entries: CatalogEntry[];
  /** The catalogue's true size for the current query, straight from the API.
   *  Falls back to `entries.length` when a source publishes no count. */
  total: number;
  /** The debounced query actually in flight, trimmed. Empty when browsing. */
  activeQuery: string;
  /** Which catalogue answered. Decides the add flow a card opens. */
  source: CatalogSource;
  isLoading: boolean;
  /**
   * Results for a PREVIOUS query are on screen while the current one is in
   * flight — the search-as-you-type window. `isLoading` is deliberately false
   * here: the grid keeps its cards and dims, instead of being replaced by
   * skeletons on every debounced keystroke.
   */
  isRefreshing: boolean;
  isError: boolean;
  /** The thrown value behind `isError`, for copy that names the real
   *  failure instead of blaming the user's connection. */
  error: unknown;
  /** Whether the catalogue has more pages for the current query. */
  hasMore: boolean;
  /** A page is in flight underneath a grid that has already painted. */
  isLoadingMore: boolean;
  /** Pull the next page. Safe to call when there is nothing to pull. */
  loadMore: () => void;
  refetch: () => void;
}

/**
 * The catalogue behind the Discovery and All tabs, from whichever of the two
 * sources this project actually has.
 *
 * **Why two sources.** `connectors_api_discover` resolves to `false` by
 * default (`apps/api/src/experimental/features.ts:83`, asserted in
 * `unit-experimental-features.test.ts:74`), so the Discover catalogue is
 * unavailable to most projects. Easy Connect (Pipedream) is not flagged. If
 * the catalogue tabs read Discover alone, every unflagged project would open
 * this page onto empty tabs — and since the Add-connector modal no longer
 * carries an Easy Connect tab, its catalogue would be unreachable entirely.
 * Falling back keeps the page populated for every project.
 *
 * **Why not merge them.** The two publish overlapping apps under different
 * slugs and different `id` namespaces, and each has its own add flow
 * (`DiscoverAddFlow` vs `ConnectorConnectionModal`). A merged list would need a
 * cross-catalogue identity that neither API provides; picking one source per
 * project is honest and keeps every card's click target unambiguous.
 *
 * Both queries are declared unconditionally — hooks cannot be called in a
 * branch — and gated with `enabled`, so exactly one is ever in flight. The
 * query keys match `discover-catalogue.tsx` and `AppCatalogue` exactly, so
 * this shares their cache entries instead of racing a duplicate fetch, which
 * is also why `useInfiniteQuery` is load-bearing rather than stylistic: those
 * surfaces cache a `{pages, pageParams}` shape under the same keys.
 *
 * **How the catalogue gets deep.** Three layers, in order of authority:
 *
 *   1. `CATALOG_INITIAL_PAGES` land eagerly on every load, so the first paint
 *      has real depth in every section rather than a handful of cards.
 *   2. A focused category keeps pulling pages until it holds
 *      `CATALOG_FOCUS_TARGET` entries, capped at `CATALOG_AUTOLOAD_MAX_PAGES`.
 *      Neither catalogue API accepts a category, so a category view is a
 *      client-side slice of what has been loaded — a thin one is thin because
 *      of the pages fetched, not because that is all the catalogue has.
 *   3. `loadMore` is unbounded and belongs to the user: `useCatalogAutoload`
 *      calls it when the foot of the grid comes into view, and the footer's
 *      button calls it from the keyboard.
 *
 * Layers 1 and 2 run from one effect that re-runs on `pages.length`, so each
 * landing page schedules the next — a chain that stops itself rather than a
 * loop that has to be broken.
 */
export function useCatalog(
  projectId: string,
  query: string,
  opts: {
    enabled: boolean;
    discoverEnabled: boolean;
    /** The category the grid is currently showing on its own, or `null` while
     *  browsing everything. Drives layer 2 above. */
    focusCategory?: string | null;
  },
): CatalogState {
  const { debouncedValue: activeQuery } = useDebounce(query.trim(), 300);
  const source: CatalogSource = opts.discoverEnabled ? 'discover' : 'easy-connect';

  const discoverQuery = useInfiniteQuery({
    queryKey: ['discover-connectors', projectId, activeQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverConnectors(projectId, activeQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    enabled: opts.enabled && source === 'discover',
    placeholderData: keepPreviousData,
  });

  const easyConnectQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, activeQuery],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, activeQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: opts.enabled && source === 'easy-connect',
    placeholderData: keepPreviousData,
  });

  const active = source === 'discover' ? discoverQuery : easyConnectQuery;

  const entries = useMemo(() => {
    if (source === 'discover') {
      return (discoverQuery.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map(catalogEntryFromDiscover);
    }
    return (easyConnectQuery.data?.pages ?? [])
      .flatMap((page) => page.apps)
      .map(catalogEntryFromEasyConnect);
  }, [source, discoverQuery.data, easyConnectQuery.data]);

  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
    refetch: activeRefetch,
  } = active;

  const loadedPages = active.data?.pages.length ?? 0;
  const focusCategory = opts.focusCategory ?? null;
  // Counted with `countInSection`, the same membership rule `groupIntoSections`
  // buckets by, so this number and the grid it is meant to fill can never
  // disagree about what belongs to the category.
  const focusLoaded = useMemo(
    () =>
      focusCategory === null
        ? 0
        : countInSection(entries, (entry) => entry.categories, focusCategory),
    [entries, focusCategory],
  );

  useEffect(() => {
    if (
      !shouldAutoLoadPage({
        enabled: opts.enabled,
        loadedPages,
        hasNextPage,
        isFetchingNextPage,
        isPlaceholderData,
        focus: focusCategory === null ? null : { loaded: focusLoaded, target: CATALOG_FOCUS_TARGET },
        initialPages: CATALOG_INITIAL_PAGES,
        maxPages: CATALOG_AUTOLOAD_MAX_PAGES,
      })
    ) {
      return;
    }
    void fetchNextPage();
  }, [
    opts.enabled,
    loadedPages,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
    focusCategory,
    focusLoaded,
    fetchNextPage,
  ]);

  // Stable identity: `useCatalogAutoload` lists this in its observer effect's
  // deps, and a new function every render would tear down and rebuild the
  // `IntersectionObserver` on each one.
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || isPlaceholderData) return;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage]);

  const refetch = useCallback(() => void activeRefetch(), [activeRefetch]);

  // Both catalogues report their true size. Discover carries it on every page;
  // Pipedream carries it as `page_info.total_count`, which the API forwards as
  // `total`. Older API builds omit it, so the loaded count is the fallback —
  // never a number larger than what is on screen.
  const reportedTotal =
    source === 'discover'
      ? discoverQuery.data?.pages[0]?.total
      : easyConnectQuery.data?.pages[0]?.total;
  const total = typeof reportedTotal === 'number' ? reportedTotal : entries.length;

  return {
    entries,
    total,
    activeQuery,
    source,
    // `isLoading` is the COLD state only — no cards on screen at all. A search
    // over a populated catalogue keeps its results and reports `isRefreshing`,
    // so the grid dims instead of blanking to skeletons.
    isLoading: opts.enabled && active.isLoading,
    isRefreshing: opts.enabled && isPlaceholderData,
    isError: active.isError,
    error: active.error,
    hasMore: opts.enabled && hasNextPage && !isPlaceholderData,
    isLoadingMore: isFetchingNextPage,
    loadMore,
    refetch,
  };
}
