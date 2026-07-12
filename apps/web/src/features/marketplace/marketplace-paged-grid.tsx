'use client';

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { PackageSearch } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useInfiniteMarketplaceItems } from '@/hooks/marketplace';
import type { ItemsPage } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import Loading from '../../components/ui/loading';
import { MarketplaceExploreCard } from './marketplace-explore-card';
import {
  buildMarketplaceGridRows,
  flattenMarketplaceItems,
  marketplaceGridRowKey,
  shouldFetchNextMarketplacePage,
  shouldVirtualizeMarketplacePagedGrid,
} from './marketplace-grid';

/**
 * Shared infinite-scroll + virtualized grid for the public marketplace pages
 * (A4): the explore landing's "See all" / search views, and the per-company
 * page. Wraps A2's `useInfiniteMarketplaceItems` and reuses A3's row-building
 * (`buildMarketplaceGridRows`) and sentinel decision
 * (`shouldFetchNextMarketplacePage`) helpers verbatim — no paging/sentinel
 * logic is reimplemented here.
 *
 * Unlike `MarketplaceBrowser` (A3), which virtualizes against a
 * caller-supplied ancestor scroll container because it's embedded inside
 * varying app-shell layouts, these public pages always render as normal page
 * content with the whole window scrolling — so this uses
 * `@tanstack/react-virtual`'s `useWindowVirtualizer` (same library, no new
 * dependency) instead of the forwarded-ref pattern.
 *
 * The first page is always rendered as a *plain*, non-virtualized grid, and
 * only pages beyond it are rendered through the windowed virtualizer. This
 * is deliberate, not a shortcut: `useWindowVirtualizer`'s range on the
 * server (and on first hydration, before layout has run) is based on a
 * 0-height viewport, so windowing from the very first render would only
 * include a small `overscan`-sized slice of the first page in the
 * server-rendered HTML — silently breaking the "SSR the first page's cards"
 * requirement. Gating on `pages.length > 1` means virtualization only ever
 * turns on after a real client-side scroll has already fetched a second
 * page, well past hydration, so there's no SSR/first-paint content to lose —
 * and a single page (≤ the configured page size) is small enough to mount
 * directly without needing to be windowed at all.
 */
export function MarketplacePagedGrid({
  query,
  type,
  source,
  columns = 3,
  gridClassName = 'sm:grid-cols-3',
  showSource = true,
  initialData,
  emptyTitle,
  emptyDescription,
  emptyAction,
  header,
}: {
  query?: string;
  type?: string;
  source?: string;
  columns?: number;
  gridClassName?: string;
  showSource?: boolean;
  initialData?: () => { pages: ItemsPage[]; pageParams: number[] };
  emptyTitle: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  header?: (info: { total: number; count: number }) => ReactNode;
}) {
  const itemsQuery = useInfiniteMarketplaceItems(
    { query, type, source, publicOnly: true },
    { initialData },
  );
  const items = useMemo(
    () => flattenMarketplaceItems(itemsQuery.data?.pages ?? []),
    [itemsQuery.data],
  );
  const total = itemsQuery.data?.pages[0]?.total ?? items.length;
  const pageCount = itemsQuery.data?.pages.length ?? 0;
  const windowed = shouldVirtualizeMarketplacePagedGrid(pageCount);

  const rows = useMemo(
    () => buildMarketplaceGridRows({ items, grouped: false, columns }),
    [items, columns],
  );
  const hasNextPage = !!itemsQuery.hasNextPage;
  const isFetchingNextPage = itemsQuery.isFetchingNextPage;
  const fetchNextPage = itemsQuery.fetchNextPage;

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

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          shouldFetchNextMarketplacePage(!!entry?.isIntersecting, {
            hasNextPage,
            isFetchingNextPage,
          })
        ) {
          fetchNextPage();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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

  return (
    <div className="space-y-3">
      {header?.({ total, count: items.length })}
      <div
        ref={gridRef}
        className="relative w-full"
        style={windowed ? { height: rowVirtualizer.getTotalSize() } : undefined}
      >
        {windowed ? (
          rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row || row.kind !== 'items') return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start - scrollMarginRef.current}px)` }}
              >
                <div className={cn('grid gap-3 pb-3', gridClassName)}>
                  {row.items.map((item) => (
                    <MarketplaceExploreCard key={item.id} item={item} showSource={showSource} />
                  ))}
                </div>
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
      {isFetchingNextPage && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-2 text-xs">
          <Loading className="size-3.5 animate-spin" />
          Loading more…
        </div>
      )}
    </div>
  );
}
