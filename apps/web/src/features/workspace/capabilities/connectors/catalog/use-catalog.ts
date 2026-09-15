'use client';

import {
  getConnectStatus,
  listConnectToolkits,
  listDiscoverConnectors,
  listPipedreamApps,
} from '@kortix/sdk';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import { useTranslations } from '@/i18n/use-translations';
import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  computersCatalogEntry,
  mergeCatalogSources,
  type CatalogEntry,
} from './catalog-entry';

/** Apps per request. One page fills several rows of the widest grid, so a
 *  scroll-triggered fetch is felt as the grid growing rather than as a jump. */
const CATALOG_PAGE_SIZE = 48;

export interface CatalogState {
  /** The pages loaded for the current query, flattened. */
  entries: CatalogEntry[];
  /** The catalogue's size for the current query. */
  total: number;
  /** The debounced query actually in flight, trimmed. Empty when browsing. */
  activeQuery: string;
  /** Apps matching the query that publish no actions, so the catalogue does
   *  not offer them. Lets the no-match state say why instead of implying the
   *  app does not exist — `q=SAP` is exactly this case. */
  excludedNoActions: number;
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
    // Version the key so tabs opened before the Composio cutover cannot keep an
    // Infinity-stale `provider: "pipedream"` answer in memory after deployment.
    queryKey: ['connect-status', 'composio-first-v2'],
    queryFn: getConnectStatus,
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
    apps: page.toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      description: toolkit.description ?? null,
      imgSrc: toolkit.logo,
      authType: toolkit.isNoAuth ? 'none' : 'oauth',
      categories: toolkit.categories ?? [],
      hasActions: true,
      hasTriggers: false,
      featuredWeight: 0,
      provider: 'composio' as const,
    })),
    categories: [],
    total: page.total,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * The catalogue behind the All tab: Easy Connect (Composio/Pipedream) is the
 * BASE catalogue on every project, and the Discover surfaces are ADDED on top
 * of it when `connectors_api_discover` is on. Discover never replaces the
 * base (Marko, 2026-09-15: "COMPOSIO doesn't have to be removed") — an app
 * both catalogues publish appears once, the Discover entry first
 * (`mergeCatalogSources`, MCP-first per COR-17).
 *
 * **One paging mechanism, two feeds.** A scroll or a click on "Load more"
 * advances BOTH sources that still have pages; the grid grows as either
 * lands. `total` is the sum of the two catalogues' own counts (an upper
 * bound: cross-catalogue duplicates collapse client-side).
 *
 * **Search is server-side in both feeds.** `q` is a query key for each, so a
 * new search starts new lists rather than re-slicing accumulated ones.
 *
 * **Easy Connect waits for the deployment probe.** No managed-provider
 * request is sent until the probe has ruled out `absent` — on a deployment
 * with no provider every one of them is a `501`. `unknown` proceeds: a
 * failed probe must not hide a catalogue that may well exist.
 *
 * **A partial failure keeps the grid.** When one source errors while the
 * other delivers, the delivered entries render and the failed feed's
 * additions are silently absent this visit; the error card shows only when
 * EVERY active source failed.
 */
export function useCatalog(
  projectId: string,
  query: string,
  opts: {
    enabled: boolean;
    discoverEnabled: boolean;
  },
): CatalogState {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { debouncedValue: activeQuery } = useDebounce(query.trim(), 300);

  // Probed unconditionally: `ConnectorsPage` gates the All tab on this same
  // answer, and a probe gated on `enabled` would have nothing left to keep it
  // answered once the tab closes — the tab would oscillate. One cached
  // request either way.
  const connectStatus = useConnectProviderStatus(true);
  const easyConnectRunnable =
    connectStatus.state === 'configured' || connectStatus.state === 'unknown';
  const easyConnectProvider = connectStatus.provider ?? 'composio';

  const discoverQuery = useInfiniteQuery({
    queryKey: ['discover-connectors', projectId, activeQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverConnectors(projectId, activeQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    enabled: opts.enabled && opts.discoverEnabled,
    placeholderData: keepPreviousData,
  });

  const easyConnectQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, activeQuery],
    queryFn: ({ pageParam }) =>
      listConnectCatalogPage({
        projectId,
        provider: easyConnectProvider,
        q: activeQuery || undefined,
        cursor: pageParam as string | undefined,
        limit: CATALOG_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: opts.enabled && easyConnectRunnable,
    placeholderData: keepPreviousData,
  });

  const entries = useMemo(() => {
    const native = computersCatalogEntry(tI18nComplete);
    // The native Computers card is ours, not the catalogue's, so it is matched
    // locally.
    const includeComputers =
      !activeQuery ||
      `${native.name} ${native.description ?? ''}`
        .toLowerCase()
        .includes(activeQuery.toLowerCase());
    const nativeEntries = includeComputers ? [native] : [];
    const discoverEntries = opts.discoverEnabled
      ? (discoverQuery.data?.pages ?? []).flatMap((page) =>
          page.items.map(catalogEntryFromDiscover),
        )
      : [];
    const easyConnectEntries = (easyConnectQuery.data?.pages ?? []).flatMap((page) =>
      page.apps.map(catalogEntryFromEasyConnect),
    );
    return nativeEntries.concat(mergeCatalogSources(discoverEntries, easyConnectEntries));
  }, [
    tI18nComplete,
    activeQuery,
    opts.discoverEnabled,
    easyConnectQuery.data?.pages,
    discoverQuery.data?.pages,
  ]);

  // Destructured so `loadMore` closes over STABLE functions and primitive
  // flags: `useCatalogAutoload` lists it in its observer effect's deps, and a
  // new identity every render would tear down and rebuild the
  // `IntersectionObserver` on each one.
  const {
    fetchNextPage: fetchNextDiscover,
    hasNextPage: discoverHasNext,
    isFetchingNextPage: discoverFetchingNext,
    isPlaceholderData: discoverPlaceholder,
    refetch: refetchDiscover,
  } = discoverQuery;
  const {
    fetchNextPage: fetchNextEasyConnect,
    hasNextPage: easyConnectHasNext,
    isFetchingNextPage: easyConnectFetchingNext,
    isPlaceholderData: easyConnectPlaceholder,
    refetch: refetchEasyConnect,
  } = easyConnectQuery;

  const discoverActive = opts.enabled && opts.discoverEnabled;
  const easyConnectActive = opts.enabled && easyConnectRunnable;
  const discoverMore = discoverActive && discoverHasNext && !discoverPlaceholder;
  const easyConnectMore = easyConnectActive && easyConnectHasNext && !easyConnectPlaceholder;

  const loadMore = useCallback(() => {
    if (discoverMore && !discoverFetchingNext) void fetchNextDiscover();
    if (easyConnectMore && !easyConnectFetchingNext) void fetchNextEasyConnect();
  }, [
    discoverMore,
    discoverFetchingNext,
    fetchNextDiscover,
    easyConnectMore,
    easyConnectFetchingNext,
    fetchNextEasyConnect,
  ]);

  const refetch = useCallback(() => {
    if (discoverActive) void refetchDiscover();
    if (easyConnectActive) void refetchEasyConnect();
  }, [discoverActive, refetchDiscover, easyConnectActive, refetchEasyConnect]);

  const easyConnectPage = easyConnectQuery.data?.pages[0];

  const excludedNoActions = easyConnectPage?.excludedNoActions ?? 0;

  const nativeCount = entries.some((entry) => entry.source === 'computer') ? 1 : 0;
  const total =
    (discoverActive ? (discoverQuery.data?.pages[0]?.total ?? 0) : 0) +
    (easyConnectActive ? (easyConnectPage?.total ?? 0) : 0) +
    nativeCount;

  const anySource = discoverActive || easyConnectActive;
  const everyActiveSourceCold =
    anySource &&
    (discoverActive ? discoverQuery.isLoading : true) &&
    (easyConnectActive ? easyConnectQuery.isLoading : true);
  const everyActiveSourceFailed =
    anySource &&
    (discoverActive ? discoverQuery.isError : true) &&
    (easyConnectActive ? easyConnectQuery.isError : true);

  return {
    entries,
    total: total > 0 ? total : entries.length,
    activeQuery,
    excludedNoActions,
    // `isLoading` is the COLD state only — no cards on screen at all. A search
    // over a populated catalogue keeps its results and reports `isRefreshing`,
    // so the grid dims instead of blanking to skeletons.
    //
    // `asking` counts as loading: the Easy Connect query is held disabled
    // until the deployment probe answers, and a disabled query reports neither
    // loading nor data — without this the grid would render "no results" for a
    // round trip before the real request had started.
    isLoading: opts.enabled && (connectStatus.state === 'asking' || everyActiveSourceCold),
    isRefreshing:
      opts.enabled &&
      ((discoverActive && discoverPlaceholder) || (easyConnectActive && easyConnectPlaceholder)),
    isError: everyActiveSourceFailed,
    error: easyConnectQuery.error ?? discoverQuery.error,
    hasMore: discoverMore || easyConnectMore,
    isLoadingMore: discoverFetchingNext || easyConnectFetchingNext,
    loadMore,
    refetch,
  };
}
