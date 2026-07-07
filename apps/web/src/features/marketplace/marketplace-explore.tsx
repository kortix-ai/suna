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
import { MarketplacePagedGrid } from '@/features/marketplace/marketplace-paged-grid';
import {
  defaultProjectMarketplaceItems,
  type MarketplaceItem,
  type MarketplaceSummary,
} from '@/lib/marketplace-client';
import {
  MARKETPLACE_GRID_COLUMNS,
  resolveMarketplaceExploreViewMode,
  resolveMarketplaceTypeSectionTotal,
  sumMarketplaceTypeCounts,
} from './marketplace-grid';
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
const SEARCH_GRID_COLUMNS = 2;

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
  type,
  total,
  showSource,
  initial = PREVIEW_COUNT,
}: {
  id: string;
  title: string;
  items: MarketplaceItem[];
  /** The type filter this section maps to — when set, "See all" routes
   *  through the server-scoped paged/virtualized view instead of mounting
   *  every card (A4). Omitted for the curated Featured rail, which never
   *  expands (it's already capped at 8). */
  type?: string;
  /** True item count for this type across the whole catalog (from marketplace
   *  summaries), not just the SSR-bounded preview — sizes the "See all N"
   *  affordance correctly even when more items exist than made it into the
   *  bounded landing fetch. */
  total?: number;
  showSource?: boolean;
  initial?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = items.slice(0, initial);
  const effectiveTotal = total ?? items.length;
  const canExpand = !!type && effectiveTotal > initial;

  return (
    <section id={id} className="scroll-mt-28">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
        {canExpand ? (
          <Button
            variant="transparent"
            size="sm"
            className="shrink-0"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : `See all ${effectiveTotal}`}
          </Button>
        ) : null}
      </div>
      {expanded && type ? (
        <MarketplacePagedGrid
          type={type}
          columns={MARKETPLACE_GRID_COLUMNS}
          gridClassName="sm:grid-cols-3"
          showSource={showSource}
          emptyTitle="No matches"
          emptyDescription="No items match this type right now."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {visible.map((item) => (
            <MarketplaceExploreCard key={item.id} item={item} showSource={showSource} />
          ))}
        </div>
      )}
    </section>
  );
}

export function MarketplaceExplore({
  items: catalogItems,
  marketplaces,
}: {
  /** SSR-bounded first page of the catalog (`MARKETPLACE_EXPLORE_LANDING_LIMIT`
   *  items, not the full catalog) — sized to fill the per-type previews below
   *  in the common case. "See all" and search results are server-scoped
   *  separately and aren't limited to this set (A4). */
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

  const featured = useMemo(() => pickFeatured(catalogItems), [catalogItems]);

  const typeCounts = useMemo(() => sumMarketplaceTypeCounts(marketplaces), [marketplaces]);

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
      .map((type) => {
        const items = byType.get(type)!;
        return {
          type,
          label: pluralize(typeMeta(type).label),
          items,
          total: resolveMarketplaceTypeSectionTotal(type, typeCounts, items.length),
        };
      });
  }, [catalogItems, typeCounts]);

  const viewMode = resolveMarketplaceExploreViewMode({
    catalogEmpty: catalogItems.length === 0,
    searching,
  });

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

        {viewMode === 'empty' ? (
          <EmptyState
            icon={PackageSearch}
            title="Nothing here yet"
            description="The catalog is empty right now — check back soon."
          />
        ) : viewMode === 'search' ? (
          <MarketplacePagedGrid
            query={debounced}
            columns={SEARCH_GRID_COLUMNS}
            gridClassName="sm:grid-cols-2"
            emptyTitle="No matches"
            emptyDescription={`No items match "${debounced}".`}
            emptyAction={
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
            header={({ total }) => (
              <div className="text-muted-foreground text-sm">
                <span className="tabular-nums">{total}</span> {total === 1 ? 'result' : 'results'}{' '}
                for &ldquo;{debounced}&rdquo;
              </div>
            )}
          />
        ) : (
          <div className="space-y-12">
            <ExploreSection id={FEATURED_ID} title="Featured" items={featured} initial={8} />
            {groups.map((g) => (
              <ExploreSection
                key={g.type}
                id={sectionId(g.type)}
                title={g.label}
                items={g.items}
                type={g.type}
                total={g.total}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
