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
import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import { MarketplacePagedGrid } from '@/features/marketplace/marketplace-paged-grid';
import type { ItemsPage, MarketplaceSummary } from '@/lib/marketplace-client';

const COMPANY_GRID_COLUMNS = 2;

export function MarketplaceCompanyExplore({
  marketplaceId,
  initialItemsPage,
  marketplaces,
}: {
  marketplaceId: string;
  /** SSR-bounded first page for this source (`MARKETPLACE_COMPANY_PAGE_LIMIT`
   *  items, server-filtered by `source`) — seeds the client's infinite query
   *  so the first paint's cards render on the server and hydrate without a
   *  refetch flash (A4). Only valid for the default (no search) view; a
   *  search re-scopes the query and fetches fresh. */
  initialItemsPage: ItemsPage;
  marketplaces: MarketplaceSummary[];
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 0;

  const company = useMemo(
    () => marketplaces.find((m) => m.id === marketplaceId),
    [marketplaces, marketplaceId],
  );

  const companyLabel = displayCompanyLabel(marketplaceId, company?.label);

  const initialData = useMemo(
    () => (searching ? undefined : () => ({ pages: [initialItemsPage], pageParams: [0] })),
    [searching, initialItemsPage],
  );

  const catalogEmpty = !searching && initialItemsPage.total === 0;

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

      {catalogEmpty ? (
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
      ) : (
        <MarketplacePagedGrid
          query={debounced}
          source={marketplaceId}
          columns={COMPANY_GRID_COLUMNS}
          gridClassName="sm:grid-cols-2"
          showSource={false}
          initialData={initialData}
          emptyTitle="No matches"
          emptyDescription={`No items match "${debounced}" in this source.`}
          emptyAction={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
          header={
            searching
              ? ({ total }) => (
                  <div className="text-muted-foreground text-sm">
                    <span className="tabular-nums">{total}</span>{' '}
                    {total === 1 ? 'result' : 'results'}
                  </div>
                )
              : undefined
          }
        />
      )}
    </div>
  );
}
