'use client';

import { useMemo } from 'react';

import { CubeIcon as Boxes } from '@phosphor-icons/react';

import { EmptyState } from '@/features/layout/section/empty-state';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { MarketplaceWorkspaceCard } from './marketplace-workspace-card';

function matches(item: MarketplaceItem, q: string): boolean {
  return `${item.name} ${item.title} ${item.description ?? ''} ${item.categories.join(' ')}`
    .toLowerCase()
    .includes(q);
}

/**
 * The Workspaces showcase on the public marketplace's landing page — the
 * primary growth surface, so it always renders (searching or not), never
 * behind a tab. Purely presentational — `items` arrives already
 * server-rendered (see `loadMarketplaceExploreData` → `workspaceItems`), so
 * this stays part of the page's static/ISR HTML for crawlers instead of
 * depending on a client-side fetch. Search is a plain client-side filter
 * over that same SSR'd list (the workspace catalog is small/hand-authored, so
 * no server round-trip is needed).
 */
export function MarketplaceWorkspacesGrid({
  items,
  query,
  size = 'featured',
}: {
  items: MarketplaceItem[];
  query?: string;
  size?: 'default' | 'featured';
}) {
  const q = (query ?? '').trim().toLowerCase();
  const visible = useMemo(() => (q ? items.filter((item) => matches(item, q)) : items), [items, q]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No workspaces yet"
        description="Ready-to-clone Kortix workspaces will show up here."
      />
    );
  }

  if (visible.length === 0) {
    return (
      <EmptyState icon={Boxes} title="No matches" description={`No workspaces match "${query}".`} />
    );
  }

  return (
    <div
      className={cn(
        'grid gap-4',
        size === 'featured' ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {visible.map((item) => (
        <MarketplaceWorkspaceCard key={item.id} item={item} size={size} />
      ))}
    </div>
  );
}
