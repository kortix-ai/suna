'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { PackageSearch } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useInfiniteMarketplaceItems, useMarketplaces } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { Search } from '@mynaui/icons-react';
import Loading from '../../components/ui/loading';
import { Icon } from '../icon/icon';
import { AddMarketplaceModal } from './add-marketplace-modal';
import {
  buildMarketplaceGridRows,
  marketplaceGridRowKey,
  resolveEffectiveMarketplaceType,
  shouldFetchNextMarketplacePage,
} from './marketplace-grid';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { TYPE_FILTERS } from './marketplace-meta';

export function MarketplaceBrowser({
  onAdd,
  installedNames,
  source: sourceProp,
  onSourceChange,
  sourceFilter,
  publicOnly = false,
  readOnly = false,
}: {
  onAdd?: (item: MarketplaceItem) => void;
  installedNames?: Set<string>;
  /** Controlled source filter (defaults to internal state). */
  source?: string;
  onSourceChange?: (source: string) => void;
  /** @deprecated Prefer `source` — kept for discover-tab handoff in project view. */
  sourceFilter?: string;
  /** Use unauthenticated public catalog reads. */
  publicOnly?: boolean;
  /** Hide project/source mutation affordances. */
  readOnly?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState('all');
  const [sourceInternal, setSourceInternal] = useState('all');
  const source = sourceProp ?? sourceFilter ?? sourceInternal;
  const [addOpen, setAddOpen] = useState(false);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);

  const marketplacesQuery = useMarketplaces({ publicOnly });
  const marketplaces = useMemo(
    () => marketplacesQuery.data?.marketplaces ?? [],
    [marketplacesQuery.data],
  );

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const list = source === 'all' ? marketplaces : marketplaces.filter((m) => m.id === source);
    for (const m of list)
      for (const [k, v] of Object.entries(m.types ?? {})) counts[k] = (counts[k] ?? 0) + v;
    return counts;
  }, [marketplaces, source]);

  const typeOptions = useMemo(
    () => TYPE_FILTERS.filter((f) => f.value === 'all' || (typeCounts[f.value] ?? 0) > 0),
    [typeCounts],
  );
  const effectiveType = resolveEffectiveMarketplaceType(type, typeOptions);

  const itemsQuery = useInfiniteMarketplaceItems({
    query: debounced,
    type: effectiveType,
    source,
    publicOnly,
  });
  const items = useMemo(
    () => itemsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [itemsQuery.data],
  );
  const grouped = effectiveType === 'all' && !debounced && source === 'all';
  const streaming = !!(itemsQuery.data?.pages[0]?.loading || marketplacesQuery.data?.loading);
  const hasNextPage = !!itemsQuery.hasNextPage;
  const isFetchingNextPage = itemsQuery.isFetchingNextPage;
  const fetchNextPage = itemsQuery.fetchNextPage;

  const rows = useMemo(() => buildMarketplaceGridRows({ items, grouped }), [items, grouped]);

  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const setListRef = useCallback((node: HTMLDivElement | null) => {
    setScrollElement(node?.closest<HTMLElement>('.overflow-y-auto') ?? null);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 64,
    overscan: 6,
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
      { root: scrollElement, rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollElement, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <InputGroup className="peer flex-1">
          <InputGroupAddon align="inline-start" className="pl-3">
            <Search className="text-muted-foreground size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrPlaceholderSearchTheMarketplace188bc1ee',
            )}
            className="peer pl-1"
          />
          {query ? (
            <InputGroupAddon align="inline-end" className="pr-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 rounded-sm opacity-0 peer-focus:opacity-100"
                onClick={() => setQuery('')}
              >
                <Icon.Close className="text-muted-foreground size-4" />
              </Button>
            </InputGroupAddon>
          ) : null}
          <InputGroupAddon align="inline-end" className="pr-2 pl-2">
            <Select value={effectiveType} onValueChange={setType}>
              <SelectTrigger variant="transparent" size="sm" arrow className="mx-0.5 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {typeOptions.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InputGroupAddon>
        </InputGroup>
        {!readOnly && (
          <Button size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
            Manage
          </Button>
        )}
      </div>

      {itemsQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
          ))}
        </div>
      ) : itemsQuery.isError ? (
        <EmptyState
          icon={PackageSearch}
          title={tI18nHardcoded.raw(
            'autoComponentsMarketplaceMarketplaceBrowserJsxAttrTitleCouldnTLoad660e12ab',
          )}
          description={(itemsQuery.error as Error)?.message ?? 'Something went wrong.'}
          action={
            <Button variant="outline" size="sm" onClick={() => itemsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        streaming ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-md" />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={PackageSearch}
            title={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrTitleNothingMatches64177fc9',
            )}
            description={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrDescriptionTryADifferentdd8061ac',
            )}
          />
        )
      ) : (
        <div
          ref={setListRef}
          className="relative w-full"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
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
                {row.kind === 'header' ? (
                  <div className="flex items-center justify-between gap-2 py-1 pt-4 first:pt-0">
                    <h3 className="text-foreground text-sm font-medium">{row.label}</h3>
                    <span className="text-muted-foreground text-[12px] tabular-nums">
                      {row.count}
                    </span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 pb-2 md:grid-cols-3">
                    {row.items.map((item) => (
                      <div
                        key={item.id}
                        className="border-border overflow-hidden rounded-md border"
                      >
                        <MarketplaceItemRow
                          item={item}
                          installed={installedNames?.has(item.name)}
                          onAdd={readOnly ? undefined : onAdd}
                          onOpen={() => openItem(item.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {items.length > 0 && hasNextPage && <div ref={sentinelRef} className="h-1" />}

      {items.length > 0 && isFetchingNextPage && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-1 text-xs">
          <Loading className="size-3.5 animate-spin" />
          Loading more…
        </div>
      )}

      {streaming && items.length > 0 && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-1 text-xs">
          <Loading className="size-3.5 animate-spin" />
          {tI18nHardcoded.raw(
            'autoComponentsMarketplaceMarketplaceBrowserJsxTextLoadingMoreSourcese06aa650',
          )}
        </div>
      )}

      {!readOnly && <AddMarketplaceModal open={addOpen} onOpenChange={setAddOpen} />}
    </div>
  );
}

function MarketplaceItemRow({
  item,
  installed,
  onAdd,
  onOpen,
}: {
  item: MarketplaceItem;
  installed?: boolean;
  onAdd?: (item: MarketplaceItem) => void;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors',
        'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
      )}
    >
      <div className="shrink-0">
        <MarketplaceItemAvatar item={item} size="sm" showSource={false} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {installed ? (
            <Badge variant="success" size="sm">
              Installed
            </Badge>
          ) : null}
        </div>
        {item.description ? (
          <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs text-pretty">
            {item.description}
          </p>
        ) : null}
      </div>
      {onAdd && !installed ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            className="transition-transform active:scale-[0.96]"
            onClick={(e) => {
              e.stopPropagation();
              onAdd(item);
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
