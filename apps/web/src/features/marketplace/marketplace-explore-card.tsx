'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import type { MarketplaceItem } from '@/lib/marketplace-client';
import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { cn } from '@/lib/utils';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';

export function MarketplaceExploreCard({
  item,
  showSource = true,
}: {
  item: MarketplaceItem;
  showSource?: boolean;
}) {
  return (
    <Link
      href={marketplaceItemHref(item.id)}
      className={cn(
        'group bg-popover hover:bg-muted/70 flex items-center gap-3.5 rounded-md border px-4 py-3',
        'transition-[background-color,transform] duration-150 active:scale-[0.99]',
      )}
    >
      <MarketplaceItemAvatar item={item} size="md" showSource={showSource} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{item.title}</div>
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
    </Link>
  );
}
