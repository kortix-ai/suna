'use client';

import {
  getConnectStatus,
  listConnectToolkits,
  listDiscoverConnectors,
  listDiscoverSections,
  listPipedreamApps,
  type DiscoverConnectorKind,
  type PipedreamCategory,
} from '@kortix/sdk';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useDebounce } from '../../../hooks/use-debounce';

import { useTranslations } from '../../../i18n';
import { browseSections, sectionsPageFromDiscover, type BrowseSectionsPage } from './browse-sections';
import { catalogEntryFromDiscover, connectToolkitApp, type CatalogEntry } from './catalog-entry';
import { CATEGORY_ROW_CAP, localizedSectionTitle } from './connector-categories';

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
export type ConnectProviderState = 'asking' | 'configured' | 'absent' | 'unknown';

export interface ConnectProviderStatus {
  state: ConnectProviderState;
  provider: 'composio' | 'pipedream' | null;
}

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
export function useConnectProviderStatus(enabled: boolean): ConnectProviderStatus {
  const query = useQuery({
    ...connectStatusQuery,
    // A deployment can change underneath an open tab. Revalidate on mount so a
    // rolling release cannot leave the catalogue pinned to the previous provider.
    staleTime: 30_000,
    refetchOnMount: 'always',
    retry: false,
    enabled,
  });
  if (!enabled) return { state: 'unknown', provider: null };
  if (query.isSuccess) {
    if (!query.data.configured) return { state: 'absent', provider: null };
    const providers = query.data.providers ?? (query.data.provider ? [query.data.provider] : []);
    // Composio is the automatic managed-provider path. Pipedream remains
    // available only on deployments that have no Composio configuration at all.
    const provider = providers.includes('composio')
      ? 'composio'
      : providers.includes('pipedream')
        ? 'pipedream'
        : null;
    return provider ? { state: 'configured', provider } : { state: 'absent', provider: null };
  }
  // A failed status probe must never silently fall back to Pipedream. Try the
  // Composio endpoint and surface its real error if the provider is unavailable.
  if (query.isError) return { state: 'unknown', provider: 'composio' };
  return { state: 'asking', provider: null };
}

/** The query behind `connect-status`, shared with the Customize prefetch. */
export const connectStatusQuery = {
  // Version the key so tabs opened before the Composio cutover cannot keep an
  // Infinity-stale `provider: "pipedream"` answer in memory after deployment.
  queryKey: ['connect-status', 'composio-first-v2'] as const,
  queryFn: getConnectStatus,
};

/**
 * The browse page's one request. Exported so the Customize prefetch
 * (`use-customize-prefetch.ts`) fills the exact cache entry the landing reads.
 */
export function catalogSectionsQuery(
  projectId: string,
  /** Just the apps that connect with nothing to set up. */
  oneClick = false,
  /** Just the apps that connect these ways. */
  kinds: readonly DiscoverConnectorKind[] = [],
) {
  return {
    queryKey: ['catalog-sections', projectId, 'kortix', ...(oneClick ? ['one-click'] : []), ...kinds] as const,
    queryFn: async (): Promise<BrowseSectionsPage> =>
      sectionsPageFromDiscover(
        await listDiscoverSections(projectId, {
          perCategory: SECTION_CARD_COUNT,
          maxCategories: SECTION_COUNT,
          ...(oneClick ? { oneClick } : {}),
          ...(kinds.length ? { kinds: [...kinds] } : {}),
        }),
      ),
    staleTime: 5 * 60_000,
  };
}

export async function listConnectCatalogPage(input: {
  projectId: string;
  provider: 'composio' | 'pipedream';
  q?: string;
  cursor?: string;
  category?: string;
  limit: number;
}) {
  const category = input.category;
  const query = {
    ...(input.q ? { q: input.q } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(category ? { category } : {}),
    limit: input.limit,
  };
  if (input.provider === 'pipedream') {
    return listPipedreamApps(input.projectId, query);
  }
  const page = await listConnectToolkits(input.projectId, query);
  return {
    apps: page.toolkits.map(connectToolkitApp),
    categories: [] as PipedreamCategory[],
    total: page.total,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * The catalogue behind the All tab: Kortix's apps, every integrations.sh
 * server and API, and the Composio apps, each app once by its best way in
 * (`apps/api/src/connectors/mcp-apps.ts`). One source, the Discover routes.
 *
 * **One paging mechanism.** A scroll or a click on "Load more" fetches the next
 * page. `q`, `oneClick` and `kinds` are query keys, so changing any of them
 * starts a new list rather than re-slicing an accumulated one.
 */
export function useCatalog(
  projectId: string,
  query: string,
  opts: {
    enabled: boolean;
    /** This deployment can pair computers; without it the Computer record goes. */
    computers?: boolean;
    /** List just the apps that connect with nothing to set up. */
    oneClick?: boolean;
    /** List just the apps that connect these ways. */
    kinds?: readonly DiscoverConnectorKind[];
  },
): CatalogState {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { debouncedValue: activeQuery } = useDebounce(query.trim(), 300);
  const hideComputerRecord = opts.computers !== true;
  const searching = activeQuery.length > 0;
  const oneClick = opts.oneClick === true;
  const kinds = useMemo(() => [...(opts.kinds ?? [])], [opts.kinds]);

  const discoverQuery = useInfiniteQuery({
    queryKey: ['discover-connectors', projectId, activeQuery, 'kortix', oneClick, ...kinds],
    queryFn: ({ pageParam }) =>
      listDiscoverConnectors(projectId, {
        q: activeQuery || undefined,
        cursor: pageParam as string | undefined,
        ...(oneClick ? { oneClick } : {}),
        ...(kinds.length ? { kinds } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    enabled: opts.enabled,
    placeholderData: keepPreviousData,
  });

  // The browse page, in one request. It answers with each category's TRUE
  // size, so a heading never reports how many cards one loaded page held.
  const sectionsQuery = useQuery({
    ...catalogSectionsQuery(projectId, oneClick, kinds),
    enabled: opts.enabled && !searching,
  });

  const entries = useMemo(
    () =>
      withoutComputerRecord(
        hideComputerRecord,
        (discoverQuery.data?.pages ?? []).flatMap((page) => page.items.map(catalogEntryFromDiscover)),
      ),
    [hideComputerRecord, discoverQuery.data?.pages],
  );

  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
    refetch: activeRefetch,
  } = discoverQuery;

  // Stable identity: `useCatalogAutoload` lists this in its observer effect's
  // deps, and a new function every render would tear down and rebuild the
  // `IntersectionObserver` on each one.
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || isPlaceholderData) return;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage]);

  // The browse page is loading until its own request lands — the paged query
  // behind it says nothing about whether the sections are ready.
  const showingSections = !searching;
  const { refetch: sectionsRefetch } = sectionsQuery;

  // Retry refetches the sections too: on the browse page they are what failed.
  const refetch = useCallback(() => {
    void activeRefetch();
    if (showingSections) void sectionsRefetch();
  }, [activeRefetch, sectionsRefetch, showingSections]);

  /**
   * The browse sections. They come from the server, complete and fixed, with
   * each section's true total. A section key is exactly what the catalogue's
   * category filter accepts, so "View all" asks for the set the heading counted.
   */
  const sections = useMemo<CatalogSection[]>(() => {
    if (searching || !sectionsQuery.data) return [];
    return browseSections(sectionsQuery.data, {
      cardCount: SECTION_CARD_COUNT,
      title: (label) => localizedSectionTitle(label, tI18nComplete),
    }).map((section) => ({ ...section, items: withoutComputerRecord(hideComputerRecord, section.items) }));
  }, [searching, sectionsQuery.data, tI18nComplete, hideComputerRecord]);

  const reportedTotal = discoverQuery.data?.pages[0]?.total;
  const total = typeof reportedTotal === 'number' ? reportedTotal : entries.length;

  // A failed sections request on the browse page is an error, not an empty
  // catalogue — without this the grid would say "no connectors" over an outage.
  const sectionsFailed = showingSections && sectionsQuery.isError;

  return {
    entries,
    total,
    activeQuery,
    sections,
    // `isLoading` is the COLD state only — no cards on screen at all. A search
    // over a populated catalogue keeps its results and reports `isRefreshing`,
    // so the grid dims instead of blanking to skeletons.
    isLoading: opts.enabled && (discoverQuery.isLoading || (showingSections && sectionsQuery.isLoading)),
    isRefreshing: opts.enabled && isPlaceholderData,
    isError: discoverQuery.isError || sectionsFailed,
    error: discoverQuery.isError ? discoverQuery.error : sectionsFailed ? sectionsQuery.error : null,
    hasMore: opts.enabled && hasNextPage && !isPlaceholderData,
    isLoadingMore: isFetchingNextPage,
    loadMore,
    refetch,
  };
}

/** The catalogue's Computer record (`native:computer`), dropped where no computer can be paired. */
function withoutComputerRecord(hide: boolean, entries: CatalogEntry[]): CatalogEntry[] {
  return hide ? entries.filter((entry) => entry.key !== 'discover:native:computer') : entries;
}
