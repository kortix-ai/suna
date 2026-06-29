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
import { EmptyState } from '@/features/layout/section/empty-state';
import { MarketplaceCompanyFilter } from '@/features/marketplace/marketplace-company-filter';
import { MarketplaceExploreCard } from '@/features/marketplace/marketplace-explore-card';
import {
  defaultProjectMarketplaceItems,
  type MarketplaceItem,
  type MarketplaceSummary,
} from '@/lib/marketplace-client';
import { filterPublicMarketplaceItems } from '@/lib/marketplace-public';
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

export function MarketplaceExplore({
  items: catalogItems,
  marketplaces,
}: {
  items: MarketplaceItem[];
  marketplaces: MarketplaceSummary[];
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 0;

  const items = useMemo(
    () => filterPublicMarketplaceItems(catalogItems, { query: debounced, type: 'all' }),
    [catalogItems, debounced],
  );
  const featured = useMemo(() => pickFeatured(catalogItems), [catalogItems]);

  const groups = useMemo(() => {
    const byType = new Map<string, MarketplaceItem[]>();
    for (const it of catalogItems) {
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
  }, [catalogItems]);

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

        <MarketplaceCompanyFilter marketplaces={marketplaces} activeId="all" className="mb-8" />

        {catalogItems.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="Nothing here yet"
            description="The catalog is empty right now — check back soon."
          />
        ) : searching && items.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="No matches"
            description={`No items match "${debounced}".`}
            action={
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
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
      </div>
    </div>
  );
}
