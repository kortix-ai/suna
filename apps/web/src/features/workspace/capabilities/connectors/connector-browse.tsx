'use client';

import { listDiscoverIntegrations, type DiscoverIntegration } from '@kortix/sdk';
import { GlobeIcon } from '@phosphor-icons/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import Image from 'next/image';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useDebounce } from '@/hooks/use-debounce';

import { CatalogCard } from '../catalog-card';
import { CatalogGrid, GRID_CLASSNAME } from '../catalog-grid';
import { CATEGORY_ROW_CAP, groupByCategory, humanizeCategory } from './connector-categories';

/**
 * The `Select`'s "no category" value. Radix `SelectItem` cannot hold an empty
 * string, so this needs a sentinel that no real category can collide with.
 * `groupByCategory` trims every key, so a leading space is unreachable by
 * construction — this is provably distinct rather than merely unlikely.
 */
export const ALL_CATEGORIES = ' all';

export interface DiscoverBrowseState {
  /** Every integration loaded so far, across all fetched pages. */
  items: DiscoverIntegration[];
  /** The catalog's true size for the current query, straight from the API. */
  total: number;
  groups: Array<{ category: string; items: DiscoverIntegration[] }>;
  /** The debounced query actually in flight, trimmed. Empty when browsing. */
  activeQuery: string;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * The browse catalog's data. Split from the component below because the
 * category `Select` belongs in the page's filter row while the cards belong in
 * its body — one owner for the data, two render sites.
 *
 * The catalog is far bigger than one screen: the live endpoint reports
 * `total: 5758` and serves 48 per page. So this pages, and every count the UI
 * shows has to be honest about which of the two numbers it means.
 *
 * The query key matches `discover-catalogue.tsx` exactly, so the Add-connector
 * modal's Discover tab and this grid share one cache entry instead of racing
 * two identical fetches.
 */
export function useDiscoverBrowse(
  projectId: string,
  query: string,
  enabled: boolean,
): DiscoverBrowseState {
  const { debouncedValue: activeQuery } = useDebounce(query.trim(), 300);

  const integrationsQuery = useInfiniteQuery({
    queryKey: ['discover-integrations', projectId, activeQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverIntegrations(projectId, activeQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    enabled,
  });

  const items = useMemo(
    () => (integrationsQuery.data?.pages ?? []).flatMap((page) => page.items),
    [integrationsQuery.data],
  );
  const groups = useMemo(() => groupByCategory(items, (item) => item.categories), [items]);

  return {
    items,
    total: integrationsQuery.data?.pages[0]?.total ?? items.length,
    groups,
    activeQuery,
    isLoading: enabled && integrationsQuery.isLoading,
    isError: integrationsQuery.isError,
    refetch: () => void integrationsQuery.refetch(),
    hasNextPage: integrationsQuery.hasNextPage,
    isFetchingNextPage: integrationsQuery.isFetchingNextPage,
    fetchNextPage: () => void integrationsQuery.fetchNextPage(),
  };
}

/**
 * The category filter. Lives in the page's filter row, right of the scope
 * tabs, and only while Browse is the active scope — the added-connector list
 * is short enough that filtering it by category is dead weight.
 *
 * Its options are the categories present in the *loaded* pages, which is also
 * exactly the set "View all" can act on, so the two can never disagree.
 */
export function CategorySelect({
  groups,
  value,
  onChange,
}: {
  groups: DiscoverBrowseState['groups'];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger variant="outline" className="h-7 w-48 text-xs">
        <SelectValue placeholder="All categories" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
        {groups.map((group) => (
          <SelectItem key={group.category} value={group.category}>
            {humanizeCategory(group.category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The Browse scope's body: the public integration catalog, grouped into
 * capped category sections.
 *
 * Three content shapes, one rule behind them — a heading must describe what is
 * under it:
 *  - **Searching:** one flat grid. The search runs server-side across the whole
 *    catalog, so category headings would fragment a result set the user asked
 *    to see as one list.
 *  - **A category picked:** one flat grid of that category, still paging.
 *  - **Otherwise:** a section per category, each capped at `CATEGORY_ROW_CAP`
 *    with "View all" to open it fully. No carousel, no arrow buttons.
 *
 * Section headings deliberately carry **no counts**. A heading reading
 * "Productivity 26" would describe the pages that happen to be loaded, not the
 * catalog — with 5,758 items behind a 48-per-page cursor it would be a lie
 * that gets worse the more the user loads. Exact counts live on the scope tabs
 * instead, where the underlying list is fully loaded.
 */
export function ConnectorBrowse({
  state,
  category,
  onCategoryChange,
  onSelect,
}: {
  state: DiscoverBrowseState;
  /** `ALL_CATEGORIES` when unfiltered. */
  category: string;
  onCategoryChange: (category: string) => void;
  onSelect: (item: DiscoverIntegration) => void;
}) {
  const { items, groups, activeQuery, total } = state;
  const searching = activeQuery.length > 0;
  // A text search overrides any category: the results are already a flat,
  // server-chosen set, and re-filtering them by a category picked before the
  // search would silently hide most of what the user asked for.
  const activeCategory = searching ? ALL_CATEGORIES : category;
  const filtered = useMemo(() => {
    if (activeCategory === ALL_CATEGORIES) return items;
    return groups.find((group) => group.category === activeCategory)?.items ?? [];
  }, [activeCategory, groups, items]);

  const card = (item: DiscoverIntegration) => (
    <CatalogCard
      key={item.id}
      leading={<IntegrationIcon icon={item.icon} />}
      title={item.name}
      description={item.description}
      onClick={() => onSelect(item)}
    />
  );

  // Loading, error and "nothing to show" are `CatalogGrid`'s contract in its
  // documented order; only the *content* branch differs between the flat and
  // sectioned shapes, so those three states are delegated here and the grid
  // gets no children it could render.
  if (state.isLoading || state.isError || filtered.length === 0) {
    return (
      <CatalogGrid
        isLoading={state.isLoading}
        isError={state.isError}
        onRetry={state.refetch}
        isEmpty
        empty={
          // Only two reachable states, not three. A picked category can never
          // come up empty: the `Select`'s options ARE `groups`, and a group
          // exists only because it has at least one item. So with no query,
          // `filtered.length === items.length` and the only way to get here is
          // a catalog that returned nothing — which is why `catalogEmptyKind`
          // is not consulted in this branch. It could only ever answer
          // `'empty'`.
          searching ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No matches for <span className="text-foreground font-mono">{activeQuery}</span>.
            </p>
          ) : (
            <EmptyState
              icon={GlobeIcon}
              size="sm"
              title="Catalog unavailable"
              description="The public integration catalog returned nothing. Try again shortly."
            />
          )
        }
      >
        {null}
      </CatalogGrid>
    );
  }

  const showSections = !searching && activeCategory === ALL_CATEGORIES;

  return (
    <div className="space-y-6">
      {showSections ? (
        groups.map((group) => (
          <section key={group.category} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-foreground text-sm font-medium">
                {humanizeCategory(group.category)}
              </h2>
              {group.items.length > CATEGORY_ROW_CAP ? (
                <Button variant="ghost" size="sm" onClick={() => onCategoryChange(group.category)}>
                  View all
                </Button>
              ) : null}
            </div>
            <div className={GRID_CLASSNAME}>
              {group.items.slice(0, CATEGORY_ROW_CAP).map(card)}
            </div>
          </section>
        ))
      ) : (
        <div className={GRID_CLASSNAME}>{filtered.map(card)}</div>
      )}

      {state.hasNextPage ? (
        <div className="flex flex-col items-center gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={state.fetchNextPage}
            disabled={state.isFetchingNextPage}
          >
            {state.isFetchingNextPage ? <Loading className="size-4 shrink-0" /> : null}
            Load more
          </Button>
          {/* Only shown unfiltered or while searching, where both numbers come
              from the same server response and the ratio is exact. Under a
              category the grid is a client-side slice of the loaded pages, so
              pairing it with the catalog total would compare two different
              things. */}
          {activeCategory === ALL_CATEGORIES ? (
            <p className="text-muted-foreground text-xs">
              {items.length.toLocaleString()} of {total.toLocaleString()}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A catalog favicon, or a neutral glyph tile when the record has none. */
function IntegrationIcon({ icon }: { icon: string | null }) {
  if (!icon) {
    return (
      <span className="bg-primary/[0.06] flex size-9 shrink-0 items-center justify-center rounded-sm">
        <GlobeIcon className="size-5" />
      </span>
    );
  }
  return (
    <span className="border-border/60 bg-card relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border">
      <Image
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        fill
        sizes="36px"
        className="object-contain p-1"
        unoptimized
      />
    </span>
  );
}
