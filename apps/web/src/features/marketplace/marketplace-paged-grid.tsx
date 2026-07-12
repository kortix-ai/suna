'use client';

import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';
import { PackageSearch } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useInfiniteMarketplaceItems } from '@/hooks/marketplace';
import type { ItemsPage, MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import Loading from '../../components/ui/loading';
import { MarketplaceExploreCard } from './marketplace-explore-card';
import {
  buildMarketplaceGridRows,
  flattenMarketplaceItems,
  marketplaceGridRowKey,
  shouldFetchNextMarketplacePage,
  shouldVirtualizeMarketplacePagedGrid,
  type MarketplaceGridRow,
} from './marketplace-grid';

/**
 * The one infinite-scroll + virtualized grid for every marketplace surface.
 *
 * Two virtualization strategies, picked by whether the caller supplies a
 * scroll ancestor:
 *  - **No `scrollContainerRef`** → `useWindowVirtualizer` (the public pages,
 *    which scroll the whole window; SSR-safe first-page-plain-grid gating).
 *  - **`scrollContainerRef` given** → `useVirtualizer` against that element
 *    (the in-project Customize panel, which owns its own scroll container).
 *
 * Both render the same `MarketplaceExploreCard` grid, so there is a single
 * card + grid implementation shared across public and in-project.
 */
export function MarketplacePagedGrid({
  query,
  type,
  source,
  publicOnly = true,
  columns = 3,
  gridClassName = 'sm:grid-cols-3',
  showSource = true,
  initialData,
  scrollContainerRef,
  emptyTitle,
  emptyDescription,
  emptyAction,
  header,
}: {
  query?: string;
  type?: string;
  source?: string;
  /** Unauthenticated catalog reads (public pages). Off for the in-project view. */
  publicOnly?: boolean;
  columns?: number;
  gridClassName?: string;
  showSource?: boolean;
  initialData?: () => { pages: ItemsPage[]; pageParams: number[] };
  /** The ancestor scroll element to virtualize against (in-project panel). When
   *  omitted, the window is the scroll container (public pages). */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  emptyTitle: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  header?: (info: { total: number; count: number }) => ReactNode;
}) {
  const itemsQuery = useInfiniteMarketplaceItems({ query, type, source, publicOnly }, { initialData });
  const items = useMemo(
    () => flattenMarketplaceItems(itemsQuery.data?.pages ?? []),
    [itemsQuery.data],
  );
  const total = itemsQuery.data?.pages[0]?.total ?? items.length;
  const pageCount = itemsQuery.data?.pages.length ?? 0;

  const rows = useMemo(
    () => buildMarketplaceGridRows({ items, grouped: false, columns }),
    [items, columns],
  );
  const hasNextPage = !!itemsQuery.hasNextPage;
  const isFetchingNextPage = itemsQuery.isFetchingNextPage;
  const fetchNextPage = itemsQuery.fetchNextPage;

  if (itemsQuery.isLoading) {
    return (
      <div className={cn('grid gap-3', gridClassName)}>
        {Array.from({ length: columns * 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-md" />
        ))}
      </div>
    );
  }

  if (itemsQuery.isError) {
    return (
      <EmptyState
        icon={PackageSearch}
        title="Couldn't load"
        description={(itemsQuery.error as Error)?.message ?? 'Something went wrong.'}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState icon={PackageSearch} title={emptyTitle} description={emptyDescription} action={emptyAction} />
    );
  }

  const grid = scrollContainerRef ? (
    <AncestorVirtualGrid
      rows={rows}
      gridClassName={gridClassName}
      showSource={showSource}
      scrollContainerRef={scrollContainerRef}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      fetchNextPage={fetchNextPage}
    />
  ) : (
    <WindowVirtualGrid
      rows={rows}
      items={items}
      windowed={shouldVirtualizeMarketplacePagedGrid(pageCount)}
      gridClassName={gridClassName}
      showSource={showSource}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      fetchNextPage={fetchNextPage}
    />
  );

  return (
    <div className="space-y-3">
      {header?.({ total, count: items.length })}
      {grid}
      {isFetchingNextPage && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-2 text-xs">
          <Loading className="size-3.5 animate-spin" />
          Loading more…
        </div>
      )}
    </div>
  );
}

/** The infinite-scroll sentinel shared by both virtualization strategies below
 *  — an `IntersectionObserver` on a trailing 1px marker that fetches the next
 *  page once it's within `rootMargin` of the given scroll root (`null` for
 *  the window, an ancestor element for the in-panel grid). Returns the ref to
 *  attach to the sentinel `<div>`. */
function useInfiniteScrollSentinel({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  root,
  rootMargin,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  root: Element | null;
  rootMargin: string;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (shouldFetchNextMarketplacePage(!!entry?.isIntersecting, { hasNextPage, isFetchingNextPage })) {
          fetchNextPage();
        }
      },
      { root, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, rootMargin, hasNextPage, isFetchingNextPage, fetchNextPage]);
  return sentinelRef;
}

/** Renders one virtualizer row — a plain grid of cards. (Headers are unused
 *  today since callers pass `grouped: false`, but handled for completeness.) */
function GridRow({
  row,
  gridClassName,
  showSource,
}: {
  row: MarketplaceGridRow;
  gridClassName: string;
  showSource: boolean;
}) {
  if (row.kind === 'header') {
    return (
      <div className="flex items-center justify-between gap-2 py-1 pt-4 first:pt-0">
        <h3 className="text-foreground text-sm font-medium">{row.label}</h3>
        <span className="text-muted-foreground text-xs tabular-nums">{row.count}</span>
      </div>
    );
  }
  return (
    <div className={cn('grid gap-3 pb-3', gridClassName)}>
      {row.items.map((item) => (
        <MarketplaceExploreCard key={item.id} item={item} showSource={showSource} />
      ))}
    </div>
  );
}

/** Window-scroll virtualization for the public pages. The first page is a plain
 *  grid (SSR-safe — see `shouldVirtualizeMarketplacePagedGrid`); windowing only
 *  turns on once a second page has been fetched client-side. */
function WindowVirtualGrid({
  rows,
  items,
  windowed,
  gridClassName,
  showSource,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  rows: MarketplaceGridRow[];
  items: MarketplaceItem[];
  windowed: boolean;
  gridClassName: string;
  showSource: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollMarginRef = useRef(0);
  useLayoutEffect(() => {
    scrollMarginRef.current = gridRef.current?.offsetTop ?? 0;
  });

  const rowVirtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 76,
    overscan: 6,
    scrollMargin: scrollMarginRef.current,
    getItemKey: (index) => marketplaceGridRowKey(rows[index], index),
  });

  const sentinelRef = useInfiniteScrollSentinel({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    root: null,
    rootMargin: '400px',
  });

  return (
    <>
      <div
        ref={gridRef}
        className="relative w-full"
        style={windowed ? { height: rowVirtualizer.getTotalSize() } : undefined}
      >
        {windowed ? (
          rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start - scrollMarginRef.current}px)` }}
              >
                <GridRow row={row} gridClassName={gridClassName} showSource={showSource} />
              </div>
            );
          })
        ) : (
          <div className={cn('grid gap-3', gridClassName)}>
            {items.map((item) => (
              <MarketplaceExploreCard key={item.id} item={item} showSource={showSource} />
            ))}
          </div>
        )}
      </div>
      {hasNextPage && <div ref={sentinelRef} className="h-1" />}
    </>
  );
}

/** Element-scroll virtualization against a caller-supplied ancestor — used
 *  inside the Customize panel, which owns its own scroll container. */
function AncestorVirtualGrid({
  rows,
  gridClassName,
  showSource,
  scrollContainerRef,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  rows: MarketplaceGridRow[];
  gridClassName: string;
  showSource: boolean;
  scrollContainerRef: RefObject<HTMLElement | null>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  // Resolve the ancestor element after mount (the ref attaches before this
  // child paints). Lazy-init captures an already-attached ref on remount.
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(
    () => scrollContainerRef.current ?? null,
  );
  useLayoutEffect(() => {
    setScrollElement(scrollContainerRef.current ?? null);
  }, [scrollContainerRef]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 76,
    overscan: 6,
    getItemKey: (index) => marketplaceGridRowKey(rows[index], index),
  });

  const sentinelRef = useInfiniteScrollSentinel({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    root: scrollElement,
    rootMargin: '200px',
  });

  return (
    <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <GridRow row={row} gridClassName={gridClassName} showSource={showSource} />
          </div>
        );
      })}
      {hasNextPage && <div ref={sentinelRef} className="h-1" />}
    </div>
  );
}
