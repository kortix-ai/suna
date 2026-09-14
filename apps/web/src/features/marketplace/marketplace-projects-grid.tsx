'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

import { CubeIcon as Boxes } from '@phosphor-icons/react';

import { EmptyState } from '@/features/layout/section/empty-state';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { MarketplaceProjectCard } from './marketplace-project-card';

function matches(item: MarketplaceItem, q: string): boolean {
  return `${item.name} ${item.title} ${item.description ?? ''} ${item.categories.join(' ')}`
    .toLowerCase()
    .includes(q);
}

/**
 * The Projects showcase on the public marketplace's landing page — the
 * primary growth surface, so it always renders (searching or not), never
 * behind a tab. Purely presentational — `items` arrives already
 * server-rendered (see `loadMarketplaceExploreData` → `projectItems`), so
 * this stays part of the page's static/ISR HTML for crawlers instead of
 * depending on a client-side fetch. Search is a plain client-side filter
 * over that same SSR'd list (the project catalog is small/hand-authored, so
 * no server round-trip is needed).
 */
export function MarketplaceProjectsGrid({
  items,
  query,
  size = 'featured',
}: {
  items: MarketplaceItem[];
  query?: string;
  size?: 'default' | 'featured';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const q = (query ?? '').trim().toLowerCase();
  const visible = useMemo(() => (q ? items.filter((item) => matches(item, q)) : items), [items, q]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title={tI18nComplete.raw('textf83c80652286')}
        description={tI18nComplete.raw('texte42e30cead8d')}
      />
    );
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title={tI18nComplete.raw('text2df01a03ff43')}
        description={tI18nComplete('text7591d1f3fb17', { value0: query ?? '' })}
      />
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
        <MarketplaceProjectCard key={item.id} item={item} size={size} />
      ))}
    </div>
  );
}
