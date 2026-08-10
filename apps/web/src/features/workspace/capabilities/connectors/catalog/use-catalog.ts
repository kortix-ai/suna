'use client';

import {
  listDiscoverConnectors,
  listPipedreamApps,
  listPipedreamSections,
  type PipedreamCategory,
} from '@kortix/sdk';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  computersCatalogEntry,
  catalogSections,
  type CatalogEntry,
  type CatalogSource,
} from './catalog-entry';
import { CATEGORY_ROW_CAP, sectionTitle } from './connector-categories';

/** Apps per request. One page fills several rows of the widest grid, so a
 *  scroll-triggered fetch is felt as the grid growing rather than as a jump. */
const CATALOG_PAGE_SIZE = 48;

/** Cards per section on the browse page, and how many sections it shows.
 *  `CATEGORY_ROW_CAP` is two rows of `xl:grid-cols-3`; 12 sections is a browse
 *  page you can scan without it becoming a directory of headings. */
const SECTION_CARD_COUNT = CATEGORY_ROW_CAP;
const SECTION_COUNT = 12;

/**
 * One browse section: a category, a fixed slice of it, and its true size.
 *
 * `total` is the catalogue's count for the category, not `items.length`. That
 * separation is the whole point — it is what lets a heading say
 * "Marketing · 207" over six cards without lying, and what stops the section
 * from having to grow to justify its own label.
 */
export interface CatalogSection {
  key: string;
  label: string;
  total: number;
  items: CatalogEntry[];
}

export interface CatalogState {
  /** The pages loaded for the current query and category, flattened. */
  entries: CatalogEntry[];
  /** The catalogue's size for the current query and category. */
  total: number;
  /** The debounced query actually in flight, trimmed. Empty when browsing. */
  activeQuery: string;
  /** Which catalogue answered. Decides the add flow a card opens. */
  source: CatalogSource;
  /** Categories the user can filter by, each with its true count. Empty for
   *  the Discover source and while the Easy Connect index is still building. */
  categories: PipedreamCategory[];
  /** Apps matching the query that publish no actions, so the catalogue does
   *  not offer them. Lets the no-match state say why instead of implying the
   *  app does not exist — `q=SAP` is exactly this case. */
  excludedNoActions: number;
  /** The browse page. Empty while searching or inside a category — both are
   *  one flat result set by definition. */
  sections: CatalogSection[];
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
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * The catalogue behind the Discovery and All tabs, from whichever of the two
 * sources this workspace actually has.
 *
 * **Why two sources.** `connectors_api_discover` resolves to `false` by
 * default (`apps/api/src/experimental/features.ts:83`), so the Discover
 * catalogue is unavailable to most projects. Easy Connect (Pipedream) is not
 * flagged. Falling back keeps the page populated for every project.
 *
 * **Why not merge them.** The two publish overlapping apps under different
 * slugs and different `id` namespaces, and each has its own add flow. A merged
 * list would need a cross-catalogue identity that neither API provides.
 *
 * **One paging mechanism.** A scroll or a click on "Load more" fetches the next
 * page. That is all. This replaces a three-layer arrangement — eager initial
 * pages, a per-category auto-deepening effect chain, and a client-side reveal
 * window over the top — that existed only because the client had to accumulate
 * enough pages to fake a category filter. The server filters by category now
 * (`pipedreamCatalogPage`), so the client asks for exactly the page it renders.
 *
 * **Filtering happens server-side, over the whole catalogue.** Both `q` and
 * `category` are query keys, so changing either starts a new list rather than
 * re-slicing an accumulated one. Pipedream's own API cannot filter by category
 * at all — see `apps/api/src/connectors/pipedream-index.ts`.
 */
export function useCatalog(
  workspaceId: string,
  query: string,
  opts: {
    enabled: boolean;
    discoverEnabled: boolean;
    /** The category the grid is filtered to, or `null` for everything. */
    focusCategory?: string | null;
  },
): CatalogState {
  const { debouncedValue: activeQuery } = useDebounce(query.trim(), 300);
  const source: CatalogSource = opts.discoverEnabled ? 'discover' : 'easy-connect';
  const category = opts.focusCategory ?? null;
  const searching = activeQuery.length > 0;

  const discoverQuery = useInfiniteQuery({
    queryKey: ['discover-connectors', workspaceId, activeQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverConnectors(workspaceId, activeQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    enabled: opts.enabled && source === 'discover',
    placeholderData: keepPreviousData,
  });

  const easyConnectQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', workspaceId, activeQuery, category],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(workspaceId, {
        ...(activeQuery ? { q: activeQuery } : {}),
        ...(category ? { category } : {}),
        ...(pageParam ? { cursor: pageParam as string } : {}),
        limit: CATALOG_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: opts.enabled && source === 'easy-connect',
    placeholderData: keepPreviousData,
  });

  // The browse page, in one request. Only while actually browsing: a search and
  // an open category are each a single flat result set, so fetching sections
  // for them would be work against a grid that will not render them.
  const sectionsQuery = useQuery({
    queryKey: ['easy-connect-sections', workspaceId],
    queryFn: () =>
      listPipedreamSections(workspaceId, {
        perCategory: SECTION_CARD_COUNT,
        maxCategories: SECTION_COUNT,
      }),
    staleTime: 5 * 60_000,
    enabled: opts.enabled && source === 'easy-connect' && !searching && category === null,
  });

  const active = source === 'discover' ? discoverQuery : easyConnectQuery;

  const entries = useMemo(() => {
    const native = computersCatalogEntry();
    // The native Computers card is ours, not the catalogue's, so it is matched
    // locally and hidden inside a category it does not claim.
    const includeComputers =
      category === null &&
      (!activeQuery ||
        `${native.name} ${native.description ?? ''}`
          .toLowerCase()
          .includes(activeQuery.toLowerCase()));
    const nativeEntries = includeComputers ? [native] : [];
    if (source === 'discover') {
      return nativeEntries.concat(
        (discoverQuery.data?.pages ?? [])
          .flatMap((page) => page.items)
          .map(catalogEntryFromDiscover),
      );
    }
    return nativeEntries.concat(
      (easyConnectQuery.data?.pages ?? [])
        .flatMap((page) => page.apps)
        .map(catalogEntryFromEasyConnect),
    );
  }, [activeQuery, category, source, discoverQuery.data, easyConnectQuery.data]);

  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
    refetch: activeRefetch,
  } = active;

  // Stable identity: `useCatalogAutoload` lists this in its observer effect's
  // deps, and a new function every render would tear down and rebuild the
  // `IntersectionObserver` on each one.
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || isPlaceholderData) return;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage]);

  const refetch = useCallback(() => void activeRefetch(), [activeRefetch]);

  /**
   * The browse sections, normalised across both sources so `ConnectorBrowse`
   * renders one shape.
   *
   * Easy Connect gets them from the server, complete and fixed. Discover has no
   * such endpoint, so it keeps the original client-side bucketing of loaded
   * entries — with `total` set to what is actually in hand, because that is all
   * that source can honestly claim.
   */
  const sections = useMemo<CatalogSection[]>(() => {
    if (searching || category !== null) return [];
    if (source === 'discover') {
      return catalogSections(entries, { popularCap: SECTION_CARD_COUNT }).map((section) => ({
        key: section.category,
        label: sectionTitle(section.category),
        total: section.items.length,
        items: section.items.slice(0, SECTION_CARD_COUNT),
      }));
    }
    return (sectionsQuery.data?.sections ?? []).map((section) => ({
      key: section.key,
      label: section.label,
      total: section.total,
      items: section.apps.map(catalogEntryFromEasyConnect),
    }));
  }, [searching, category, source, entries, sectionsQuery.data]);

  const easyConnectPage = easyConnectQuery.data?.pages[0];
  const categories = source === 'easy-connect' ? (easyConnectPage?.categories ?? []) : [];

  const excludedNoActions = easyConnectPage?.excludedNoActions ?? 0;

  const reportedTotal =
    source === 'discover' ? discoverQuery.data?.pages[0]?.total : easyConnectPage?.total;
  const nativeCount = entries.some((entry) => entry.source === 'computer') ? 1 : 0;
  const total = typeof reportedTotal === 'number' ? reportedTotal + nativeCount : entries.length;

  // The browse page is loading until its own request lands — the paged query
  // behind it says nothing about whether the sections are ready.
  const showingSections = !searching && category === null && source === 'easy-connect';

  return {
    entries,
    total,
    activeQuery,
    source,
    categories,
    excludedNoActions,
    sections,
    // `isLoading` is the COLD state only — no cards on screen at all. A search
    // over a populated catalogue keeps its results and reports `isRefreshing`,
    // so the grid dims instead of blanking to skeletons.
    isLoading: opts.enabled && (active.isLoading || (showingSections && sectionsQuery.isLoading)),
    isRefreshing: opts.enabled && isPlaceholderData,
    isError: active.isError,
    error: active.error,
    hasMore: opts.enabled && hasNextPage && !isPlaceholderData,
    isLoadingMore: isFetchingNextPage,
    loadMore,
    refetch,
  };
}
