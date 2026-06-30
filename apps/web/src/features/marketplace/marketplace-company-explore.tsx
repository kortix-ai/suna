'use client';

import { PackageSearch, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  MarketplaceCompanyFilter,
  displayCompanyLabel,
} from '@/features/marketplace/marketplace-company-filter';
import { MarketplaceExploreCard } from '@/features/marketplace/marketplace-explore-card';
import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import type { MarketplaceItem, MarketplaceSummary } from '@/lib/marketplace-client';
import { filterPublicMarketplaceItems } from '@/lib/marketplace-public';

export function MarketplaceCompanyExplore({
  marketplaceId,
  items: catalogItems,
  marketplaces,
}: {
  marketplaceId: string;
  items: MarketplaceItem[];
  marketplaces: MarketplaceSummary[];
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const company = useMemo(
    () => marketplaces.find((m) => m.id === marketplaceId),
    [marketplaces, marketplaceId],
  );

  const items = useMemo(
    () =>
      filterPublicMarketplaceItems(catalogItems, {
        query: debounced,
        type: 'all',
        source: marketplaceId,
      }),
    [catalogItems, debounced, marketplaceId],
  );

  const companyLabel = displayCompanyLabel(marketplaceId, company?.label);

  return (
    <div className="mx-auto max-w-6xl px-6 py-16 pt-28 pb-24 lg:px-0 lg:pt-40">
      <div className="mb-8">
        <nav className="text-muted-foreground mb-6 flex items-center gap-1.5 text-sm">
          <Link href="/marketplace" className="hover:text-foreground transition-colors">
            Marketplace
          </Link>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <span className="text-foreground truncate">{companyLabel}</span>
        </nav>

        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <MarketplaceAvatar
              id={marketplaceId}
              owner={company?.owner}
              sourceUrl={company?.sourceUrl}
              label={company?.label}
              size="lg"
            />
            <div className="min-w-0 space-y-1">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                {companyLabel}
              </h1>
              {company ? (
                <p className="text-muted-foreground text-sm tabular-nums">
                  {company.count} {company.count === 1 ? 'item' : 'items'}
                </p>
              ) : null}
            </div>
          </div>
          <div className="w-full sm:w-72">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder="Search this source"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          </div>
        </header>
      </div>

      <MarketplaceCompanyFilter
        marketplaces={marketplaces}
        activeId={marketplaceId}
        className="mb-8"
      />

      {catalogItems.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="Nothing here yet"
          description="This source has no browseable items right now."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/marketplace">Browse all sources</Link>
            </Button>
          }
        />
      ) : debounced && items.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="No matches"
          description={`No items match "${debounced}" in this source.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {debounced ? (
            <div className="text-muted-foreground text-sm">
              <span className="tabular-nums">{items.length}</span>{' '}
              {items.length === 1 ? 'result' : 'results'}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <MarketplaceExploreCard key={item.id} item={item} showSource={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
