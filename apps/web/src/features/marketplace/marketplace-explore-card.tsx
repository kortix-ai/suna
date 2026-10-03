'use client';

import { useTranslations } from '@/i18n/use-translations';
import { CaretRightIcon as ChevronRight } from '@phosphor-icons/react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { useMarketplaceSurface } from './marketplace-surface';

/**
 * The one marketplace card — skills, projects, a project's contents and the
 * "Related" grid all render this, so every tile on every marketplace surface
 * shares one box: a filled `bg-card` tile (one boundary, no hairline), a
 * 40px identity tile, a one-line title + one-line description, and a trailing
 * chevron that darkens on hover. Nothing moves on hover; only the fill steps up.
 */
export function MarketplaceExploreCard({
  item,
  showSource = true,
  navigable = true,
}: {
  item: MarketplaceItem;
  showSource?: boolean;
  /** When false, the card is a static tile (no link/button, no chevron) — used
   *  for a project's own agents/triggers, which aren't their own catalog items
   *  but should still read exactly like the skill boxes. */
  navigable?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const surface = useMarketplaceSurface();
  const installed = surface.variant === 'project' && surface.installedNames.has(item.name);

  const className = cn(
    'group bg-card flex w-full min-w-0 items-center gap-3 rounded-md px-4 py-2.5 text-left',
    navigable && 'hover:bg-muted transition-colors duration-(--duration-normal)',
  );

  const inner = (
    <>
      <MarketplaceItemAvatar item={item} size="md" showSource={showSource} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-base">{item.title}</span>
          {installed ? (
            <Badge variant="success" size="sm" className="shrink-0">
              {tI18nComplete.raw('textf8b32f4e92bd')}
            </Badge>
          ) : null}
        </div>
        {item.description ? (
          <p className="text-muted-foreground truncate text-sm">{item.description}</p>
        ) : null}
      </div>
      {navigable ? (
        <ChevronRight
          className="text-muted-foreground group-hover:text-foreground size-3 shrink-0 transition-colors duration-(--duration-normal)"
          aria-hidden
        />
      ) : null}
    </>
  );

  if (!navigable) {
    return <div className={className}>{inner}</div>;
  }
  // Public surface renders a real crawlable link; the in-project overlay uses a
  // button that opens the detail store (can't navigate away from the panel).
  if (surface.variant === 'public') {
    return (
      <Link href={surface.itemHref(item.id)} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => surface.openItem(item.id)} className={className}>
      {inner}
    </button>
  );
}
