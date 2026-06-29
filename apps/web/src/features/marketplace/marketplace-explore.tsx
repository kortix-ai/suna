'use client';

import { PackageSearch, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { MarketplaceCompanyFilter } from '@/features/marketplace/marketplace-company-filter';
import { MarketplaceExploreCard } from '@/features/marketplace/marketplace-explore-card';
import { useMarketplaceItems, useMarketplaces } from '@/hooks/marketplace';
import { defaultProjectMarketplaceItems, type MarketplaceItem } from '@/lib/marketplace-client';
import { typeMeta } from './marketplace-meta';

const TYPE_ORDER = [
  'registry:skill',
  'registry:agent',
  'registry:command',
  'registry:bundle',
  'registry:tool',
  'registry:rules',
  'registry:file',
];

const FEATURED_ID = 'featured';
const PREVIEW_COUNT = 9;

function sectionId(type: string): string {
  return `type-${type.replace('registry:', '')}`;
}

function pluralize(label: string): string {
  return label.endsWith('s') ? label : `${label}s`;
}

function pickFeatured(items: MarketplaceItem[]): MarketplaceItem[] {
  const curated = defaultProjectMarketplaceItems(items);
  if (curated.length) return curated.slice(0, 8);
  const kortix = items.filter((i) => i.marketplaceId === 'kortix');
  return (kortix.length ? kortix : items).slice(0, 8);
}

function ExploreSection({
  id,
  title,
  items,
  showSource,
  initial = PREVIEW_COUNT,
}: {
  id: string;
  title: string;
  items: MarketplaceItem[];
  showSource?: boolean;
  initial?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initial);

  return (
    <section id={id} className="scroll-mt-28">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
        {items.length > initial ? (
          <Button
            variant="transparent"
            size="sm"
            className="shrink-0"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : `See all ${items.length}`}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {visible.map((item) => (
          <MarketplaceExploreCard key={item.id} item={item} showSource={showSource} />
        ))}
      </div>
    </section>
  );
}

export function MarketplaceExplore() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 0;
  const marketplacesQuery = useMarketplaces({ publicOnly: true });
  const marketplaces = useMemo(
    () => marketplacesQuery.data?.marketplaces ?? [],
    [marketplacesQuery.data],
  );

  const { data, isLoading, isError, refetch } = useMarketplaceItems({
    query: debounced,
    type: 'all',
    publicOnly: true,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const featured = useMemo(() => pickFeatured(items), [items]);

  const groups = useMemo(() => {
    const byType = new Map<string, MarketplaceItem[]>();
    for (const it of items) {
      const arr = byType.get(it.type) ?? [];
      arr.push(it);
      byType.set(it.type, arr);
    }
    return [...byType.keys()]
      .sort((a, b) => {
        const ia = TYPE_ORDER.indexOf(a);
        const ib = TYPE_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      })
      .map((type) => ({ type, label: pluralize(typeMeta(type).label), items: byType.get(type)! }));
  }, [items]);

  const navItems = useMemo(
    () => [
      { id: FEATURED_ID, label: 'Featured' },
      ...groups.map((g) => ({ id: sectionId(g.type), label: g.label })),
    ],
    [groups],
  );

  const scrollTo = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-16 pt-28 pb-24 lg:px-0 lg:pt-40">
      <div className="flex flex-col gap-2">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance">
              Marketplace
            </h1>
          </div>
          <div className="w-full sm:w-80">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder="Search the marketplace"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          </div>
        </header>

        {!marketplacesQuery.isLoading ? (
          <MarketplaceCompanyFilter marketplaces={marketplaces} activeId="all" className="mb-8" />
        ) : null}

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-32 rounded" />
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[78px] rounded-md" />
              ))}
            </div>
          </div>
        ) : isError ? (
          <EmptyState
            icon={PackageSearch}
            title="Couldn't load the marketplace"
            description="Something went wrong fetching the catalog."
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={searching ? 'No matches' : 'Nothing here yet'}
            description={
              searching
                ? `No items match "${debounced}".`
                : 'The catalog is empty right now — check back soon.'
            }
            action={
              searching ? (
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        ) : searching ? (
          <div className="space-y-3">
            <div className="text-muted-foreground text-sm">
              <span className="tabular-nums">{items.length}</span>{' '}
              {items.length === 1 ? 'result' : 'results'} for &ldquo;{debounced}&rdquo;
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((item) => (
                <MarketplaceExploreCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-12">
            <ExploreSection id={FEATURED_ID} title="Featured" items={featured} initial={8} />
            {groups.map((g) => (
              <ExploreSection key={g.type} id={sectionId(g.type)} title={g.label} items={g.items} />
            ))}
          </div>
        )}

        {!isLoading && (data?.pending ?? 0) > 0 ? (
          <div className="text-muted-foreground mt-8 flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            Loading more sources…
          </div>
        ) : null}
      </div>
    </div>
  );
}
