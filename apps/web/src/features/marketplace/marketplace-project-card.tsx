'use client';

import { ArrowRight, Boxes } from 'lucide-react';
import Link from 'next/link';

import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { projectBannerClass } from './marketplace-project-visual';
import { useMarketplaceSurface } from './marketplace-surface';

/**
 * A whole clonable project — the primary surface of the marketplace, so this
 * reads as an action card (banner + explicit "Clone" affordance), not a small
 * utility row like `MarketplaceExploreCard` (skills/agents/commands). Still
 * just a link to the item's detail page — the real Clone button lives there
 * (`MarketplaceCloneButton`); this is a preview + fast path into it.
 *
 * `size="featured"` is the showcase treatment used in the landing hero;
 * `"default"` is the compact form used for cross-links (e.g. "Other
 * projects" on a project's own detail page).
 */
export function MarketplaceProjectCard({
  item,
  size = 'default',
}: {
  item: MarketplaceItem;
  size?: 'default' | 'featured';
}) {
  const { itemHref, openItem } = useMarketplaceSurface();
  const featured = size === 'featured';
  const banner = projectBannerClass(item.name || item.id);
  const skillCount = item.dependencies.length;

  const className = cn(
    'group bg-popover hover:border-foreground/20 flex w-full flex-col overflow-hidden rounded-md border text-left',
    'transition-[border-color,transform] duration-150 active:scale-[0.99]',
  );
  const body = (
    <>
      <div
        className={cn(
          'flex items-center justify-center bg-gradient-to-br',
          banner,
          featured ? 'h-32' : 'h-20',
        )}
      >
        <Boxes className={cn('text-foreground/60', featured ? 'size-9' : 'size-6')} aria-hidden />
      </div>
      <div className={cn('flex flex-1 flex-col gap-4', featured ? 'p-6' : 'p-5')}>
        <div className="min-w-0 space-y-1.5">
          <div
            className={cn(
              'text-foreground font-medium tracking-tight capitalize',
              featured ? 'text-lg' : 'text-base',
            )}
          >
            {item.title.replaceAll('-', ' ')}
          </div>
          {item.description ? (
            <p className="text-muted-foreground line-clamp-2 text-sm leading-relaxed text-pretty">
              {item.description}
            </p>
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <span className="text-muted-foreground/70 text-xs tabular-nums">
            {skillCount > 0 ? `${skillCount} ${skillCount === 1 ? 'skill' : 'skills'} included` : ''}
          </span>
          <span className="text-foreground group-hover:text-kortix-blue inline-flex shrink-0 items-center gap-1 text-sm font-medium transition-colors">
            Install
            <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </>
  );

  if (itemHref) {
    return (
      <Link href={itemHref(item.id)} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => openItem(item.id)} className={className}>
      {body}
    </button>
  );
}
