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
}: {
  item: MarketplaceItem;
  showSource?: boolean;
}) {
  const { itemHref, openItem, installedNames } = useMarketplaceSurface();
  const installed = installedNames.has(item.name);

  const className = cn(
    'group bg-popover hover:bg-muted/70 flex w-full items-center gap-3.5 rounded-md border px-4 py-3 text-left',
    'transition-[background-color,transform] duration-150 active:scale-[0.99]',
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
      <ChevronRight
        className="text-muted-foreground/50 size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
        aria-hidden
      />
    </>
  );

  // Public surface renders a real crawlable link; the in-project overlay uses a
  // button that opens the detail store (can't navigate away from the panel).
  if (itemHref) {
    return (
      <Link href={itemHref(item.id)} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => openItem(item.id)} className={className}>
      {inner}
    </button>
  );
}
