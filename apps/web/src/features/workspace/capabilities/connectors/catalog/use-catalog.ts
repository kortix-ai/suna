'use client';

import {
  getConnectStatus,
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
  catalogSections,
  computersCatalogEntry,
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
 * What this DEPLOYMENT knows about Easy Connect (Pipedream).
 *
 * `absent` is the only actionable answer: it means the surface must not be
 * offered at all. `unknown` and `asking` both mean "carry on as before" — one
 * because the probe has not answered yet, the other because it never will.
 */
export type PipedreamStatus = 'asking' | 'configured' | 'absent' | 'unknown';

/**
 * Is Easy Connect (Pipedream) configured on this deployment?
 *
 * `listPipedreamApps` / `listPipedreamSections` are wired into the API router
 * only when `pipedreamConfigured()` is true — three env vars, checked in
 * `apps/api/src/connectors/pipedream.ts`. Without them every call answers
 * `501 FEATURE_NOT_SUPPORTED`, and a self-host that never set them is the
 * entire population of that branch. The page used to spend a request per load
 * discovering that, then paint the generic "Server error … (501)" card over a
 * catalogue it could never have had.
 *
 * **Deployment-wide, so it is keyed without the project** — `['connect-status']`
 * is the same entry `customize/sections/connectors-view.tsx` reads, so the two
 * surfaces share one request — and it never goes stale: the answer is an
 * environment variable on the server and cannot change while the tab is open.
 *
 * **Not retried.** A probe that cannot run is not evidence that the provider is
 * missing, so a failure resolves to `unknown` and the catalogue proceeds. Three
 * backed-off retries would only hold the grid on skeletons for seconds before
 * reaching the same conclusion.
 */
export function usePipedreamStatus(enabled: boolean): PipedreamStatus {
  const query = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: Infinity,
    retry: false,
    enabled,
  });
  if (!enabled) return 'unknown';
  if (query.isSuccess) return query.data.configured ? 'configured' : 'absent';
  if (query.isError) return 'unknown';
  return 'asking';
}

/**
 * The catalogue behind the Discovery and All tabs, from whichever of the two
 * sources this project actually has.
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
 *
 * **Easy Connect waits for the deployment probe.** No Pipedream request is sent
 * until `usePipedreamStatus` has ruled out `absent`, because on a deployment
 * without Pipedream credentials every one of them is a `501` — and one landing
 * before the probe would paint the error card the probe exists to prevent. The
 * cost is one round trip on the first load of the session, spent on a route that
 * only reads env vars, and the wait is reported as `isLoading` so the grid holds
 * its skeletons instead of flashing an empty result.
 */
export function useCatalog(
  projectId: string,
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

  // Probed whenever Easy Connect is the source, whether or not the catalogue is
  // `enabled`. `ConnectorsPage` turns Discovery and All OFF when this answers
  // `absent`, which turns `enabled` off with them — a probe gated on `enabled`
  // would then have nothing left to keep it answered, and the tabs would
  // oscillate. It is one cached request either way.
  const pipedreamStatus = usePipedreamStatus(source === 'easy-connect');

  // `unknown` proceeds: the probe failed, and refusing to load a catalogue that
  // may well exist is the worse of the two mistakes.
  const easyConnectRunnable =
    source === 'easy-connect' &&
    (pipedreamStatus === 'configured' || pipedreamStatus === 'unknown');

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
    queryKey: ['easy-connect-apps', projectId, activeQuery, category],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, {
        ...(activeQuery ? { q: activeQuery } : {}),
        ...(category ? { category } : {}),
        ...(pageParam ? { cursor: pageParam as string } : {}),
        limit: CATALOG_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: opts.enabled && easyConnectRunnable,
    placeholderData: keepPreviousData,
  });

  // The browse page, in one request. Only while actually browsing: a search and
  // an open category are each a single flat result set, so fetching sections
  // for them would be work against a grid that will not render them.
  const sectionsQuery = useQuery({
    queryKey: ['easy-connect-sections', projectId],
    queryFn: () =>
      listPipedreamSections(projectId, {
        perCategory: SECTION_CARD_COUNT,
        maxCategories: SECTION_COUNT,
      }),
    staleTime: 5 * 60_000,
    enabled: opts.enabled && easyConnectRunnable && !searching && category === null,
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
        (discoverQuery.data?.pages ?? []).flatMap((page) =>
          page.items.map(catalogEntryFromDiscover),
        ),
      );
    }
    return nativeEntries.concat(
      (easyConnectQuery.data?.pages ?? []).flatMap((page) =>
        page.apps.map(catalogEntryFromEasyConnect),
      ),
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
    //
    // `asking` counts as loading: the Easy Connect queries are held disabled
    // until the deployment probe answers, and a disabled query reports neither
    // loading nor data — without this the grid would render "no results" for a
    // round trip before the real request had started.
    isLoading:
      opts.enabled &&
      (pipedreamStatus === 'asking' ||
        active.isLoading ||
        (showingSections && sectionsQuery.isLoading)),
    isRefreshing: opts.enabled && isPlaceholderData,
    isError: active.isError,
    error: active.error,
    hasMore: opts.enabled && hasNextPage && !isPlaceholderData,
    isLoadingMore: isFetchingNextPage,
    loadMore,
    refetch,
  };
}
