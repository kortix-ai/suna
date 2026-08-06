'use client';

import { listDiscoverConnectors, listPipedreamApps } from '@kortix/sdk';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  type CatalogEntry,
  type CatalogSource,
} from './catalog-entry';
import { CATALOG_PREFETCH_PAGES, shouldPrefetchMorePages } from './catalog-prefetch';

export interface CatalogState {
  /** The first page, normalised. There is no second one — see the note on
   *  `useInfiniteQuery` below. */
  entries: CatalogEntry[];
  /** The catalogue's true size for the current query, straight from the API.
   *  Larger than `entries.length` by design; the page says so at its foot. */
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
  refetch: () => void;
}

/**
 * The catalogue behind the Discover / All / Available tabs, from whichever of
 * the two sources this project actually has.
 *
 * **Why two sources.** `connectors_api_discover` resolves to `false` by
 * default (`apps/api/src/experimental/features.ts:83`, asserted in
 * `unit-experimental-features.test.ts:74`), so the Discover catalogue is
 * unavailable to most projects. Easy Connect (Pipedream) is not flagged. If
 * the catalogue tabs read Discover alone, every unflagged project would open
 * this page onto three empty tabs — and since the Add-connector modal no
 * longer carries an Easy Connect tab, its catalogue would be unreachable
 * entirely. Falling back keeps the page populated for every project.
 *
 * **Why not merge them.** The two publish overlapping apps under different
 * slugs and different `id` namespaces, and each has its own add flow
 * (`DiscoverAddFlow` vs `ConnectorConnectionModal`). A merged list would need a
 * cross-catalogue identity that neither API provides; picking one source per
 * project is honest and keeps every card's click target unambiguous.
 *
 * Both queries are declared unconditionally — hooks cannot be called in a
 * branch — and gated with `enabled`, so exactly one is ever in flight.
 *
 * The Discover query key matches `connector-browse.tsx`'s previous key and
 * `discover-catalogue.tsx` exactly, and the Easy Connect key matches
 * `AppCatalogue`'s, so this shares their cache entries instead of racing a
 * duplicate fetch against them.
 *
 * **Why `useInfiniteQuery` for a surface that never asks for a second page.**
 * Nothing here calls `fetchNextPage`, and the state this returns exposes no
 * way to — the connectors page paginates by neither button nor scroll. A plain
 * `useQuery` would look tidier and would be wrong: it caches a flat response
 * under these keys, while `discover-catalogue.tsx` and `AppCatalogue` cache a
 * `{pages, pageParams}` shape under the SAME keys. Changing shape here forks
 * the cache and reintroduces the duplicate fetch the shared keys exist to
 * prevent. `getNextPageParam` stays for the same reason — it is part of that
 * shape, not a claim that anything pages.
 */
export function useCatalog(
  projectId: string,
  query: string,
  opts: { enabled: boolean; discoverEnabled: boolean },
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

  // Depth, in the background. One page of 48 spread across ~11 sections left
  // several with a handful of cards, so "View all" on Productivity opened 8.
  // Pages 2-4 arrive underneath a grid that has already painted: `isLoading`
  // stays bound to the first page, `isFetchingNextPage` is not exposed on
  // `CatalogState`, and nothing here is reachable by a control. This adds depth
  // WITHOUT reintroducing pagination.
  //
  // The effect re-runs on `pages.length`, so each landing page schedules the
  // next — a chain that stops itself at `CATALOG_PREFETCH_PAGES` rather than a
  // loop that has to be broken.
  const loadedPages = active.data?.pages.length ?? 0;
  const {
    fetchNextPage: activeFetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
  } = active;
  useEffect(() => {
    if (!opts.enabled) return;
    // While `placeholderData` is showing, `data` belongs to the PREVIOUS query
    // key — `loadedPages` and `hasNextPage` describe that one, not the search
    // now in flight. Paging off it would fire a cursor request against a query
    // whose first page has not landed.
    if (isPlaceholderData) return;
    if (
      !shouldPrefetchMorePages({
        loadedPages,
        maxPages: CATALOG_PREFETCH_PAGES,
        hasNextPage,
        isFetchingNextPage,
      })
    ) {
      return;
    }
    void activeFetchNextPage();
  }, [
    opts.enabled,
    loadedPages,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
    activeFetchNextPage,
  ]);

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

  // Discover reports the catalogue's true size; Pipedream's paged response
  // does not carry one, so the honest answer there is what has been loaded.
  const total =
    source === 'discover'
      ? (discoverQuery.data?.pages[0]?.total ?? entries.length)
      : entries.length;

  return {
    entries,
    total,
    activeQuery,
    source,
    // `isLoading` is now the COLD state only — no cards on screen at all.
    // A search over a populated catalogue keeps its results and reports
    // `isRefreshing`, so the grid dims instead of blanking to skeletons.
    isLoading: opts.enabled && active.isLoading,
    isRefreshing: opts.enabled && active.isPlaceholderData,
    isError: active.isError,
    refetch: () => void active.refetch(),
  };
}
