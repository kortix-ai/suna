'use client';

/**
 * The catalogue card and grid the logged-out Connectors screen browses.
 *
 * This is the card the signed-in grid SHOULD use too. Today's signed-in
 * catalogues (`AppCatalogue` in customize/sections/connectors-view.tsx and
 * `DiscoverCatalogue`) each hand-roll their own `<button>` card, and neither
 * exports one — so there was nothing to import. Rather than copy that markup,
 * this is built from the design system's Item primitives, keeps the same
 * 2/3/4-column geometry those grids already use, and takes a plain item shape
 * so a real catalogue row can be mapped onto it unchanged. Collapsing the two
 * signed-in grids onto it is the follow-up that removes the drift risk.
 *
 * It renders no connection state. There is no "Connected" variant, no tick and
 * no count, because the only caller today is a visitor with no account.
 */

import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/lib/utils';

export interface ConnectorCatalogueItem {
  slug: string;
  name: string;
  /** Bare domain — resolved to the service's real logo. */
  domain: string;
  description: string;
}

export interface ConnectorCatalogueCardProps {
  item: ConnectorCatalogueItem;
  /** Fires on the whole card and on the add affordance. */
  onSelect: (item: ConnectorCatalogueItem) => void;
  className?: string;
}

export function ConnectorCatalogueCard({ item, onSelect, className }: ConnectorCatalogueCardProps) {
  return (
    <Item asChild variant="outline" size="sm" className={cn('items-start', className)}>
      <button
        type="button"
        data-slot="connector-catalogue-card"
        data-connector={item.slug}
        onClick={() => onSelect(item)}
        aria-label={`Add ${item.name}`}
        className="group hover:bg-accent/50 focus-visible:ring-ring/50 w-full cursor-pointer text-left transition-colors focus-visible:ring-[3px]"
      >
        <ItemMedia>
          <FaviconAvatar value={item.domain} size="md" alt="" />
        </ItemMedia>
        <ItemContent className="gap-0.5">
          <ItemTitle className="max-w-full truncate">{item.name}</ItemTitle>
          <ItemDescription className="text-xs">{item.description}</ItemDescription>
        </ItemContent>
        <ItemActions className="self-start">
          <Plus
            aria-hidden="true"
            className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors"
          />
        </ItemActions>
      </button>
    </Item>
  );
}

export interface ConnectorCatalogueGridProps {
  items: readonly ConnectorCatalogueItem[];
  onSelect: (item: ConnectorCatalogueItem) => void;
  /** Optional group heading rendered above the grid. */
  label?: ReactNode;
  className?: string;
}

export function ConnectorCatalogueGrid({
  items,
  onSelect,
  label,
  className,
}: ConnectorCatalogueGridProps) {
  return (
    <section className={cn('space-y-2', className)}>
      {label ? (
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide">{label}</h2>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <ConnectorCatalogueCard key={item.slug} item={item} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

export default ConnectorCatalogueGrid;
