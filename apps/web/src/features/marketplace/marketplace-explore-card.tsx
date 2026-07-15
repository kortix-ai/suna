'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { useMarketplaceSurface } from './marketplace-surface';

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
  const surface = useMarketplaceSurface();
  const installed = surface.variant === 'project' && surface.installedNames.has(item.name);

  const className = cn(
    'group bg-popover flex w-full items-center gap-3.5 rounded-md border px-4 py-3 text-left',
    navigable &&
      'hover:bg-muted/70 transition-[background-color,transform] duration-150 active:scale-[0.99]',
  );

  const inner = (
    <>
      <MarketplaceItemAvatar item={item} size="md" showSource={showSource} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {installed ? (
            <Badge variant="success" size="sm" className="shrink-0">
              Installed
            </Badge>
          ) : null}
        </div>
        {item.description ? (
          <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs leading-relaxed text-pretty">
            {item.description}
          </p>
        ) : null}
      </div>
      {navigable ? (
        <ChevronRight
          className="text-muted-foreground/50 size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
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
