'use client';

import {
  BookOpen,
  Boxes,
  Brain,
  Code,
  Compass,
  Database,
  FileCode2,
  FlaskConical,
  Globe,
  Layers,
  Lightbulb,
  PenTool,
  Puzzle,
  Rocket,
  Sparkles,
  Terminal,
  Wand2,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { EntityAvatar, type EntityAvatarSize } from '@/components/ui/entity-avatar';
import { cn } from '@/lib/utils';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { MarketplaceAvatar } from './marketplace-avatar';

// A curated, "capability"-flavored icon pool. Every skill is assigned one mark
// deterministically from its name, so a gallery reads as a varied set instead
// of a wall of identical sparkles.
const ICON_POOL: readonly LucideIcon[] = [
  Sparkles,
  Wand2,
  Wrench,
  Terminal,
  Code,
  FileCode2,
  BookOpen,
  Brain,
  Lightbulb,
  Globe,
  Database,
  Layers,
  Boxes,
  Puzzle,
  Compass,
  Rocket,
  PenTool,
  FlaskConical,
  Zap,
];

const SIZE_TO_ENTITY: Record<'sm' | 'md' | 'lg', EntityAvatarSize> = {
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};

/** Stable 32-bit hash of a string. */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

type ItemLike = Pick<
  MarketplaceItem,
  'name' | 'id' | 'marketplaceId' | 'marketplaceLabel' | 'owner' | 'sourceUrl'
>;

/**
 * Identity tile for a single marketplace ITEM (a skill). Picks a deterministic
 * icon from the item's name and pins the source avatar as a corner badge for
 * provenance. All deterministic — no flash, no layout shift.
 */
export function MarketplaceItemAvatar({
  item,
  size = 'md',
  showSource = true,
  className,
}: {
  item: ItemLike;
  size?: keyof typeof SIZE_TO_ENTITY;
  /** Render the source favicon corner badge (hide when already browsing one source). */
  showSource?: boolean;
  className?: string;
}) {
  const seed = item.name || item.id;
  const Icon = ICON_POOL[hashOf(seed) % ICON_POOL.length];
  const hasSource = !!(item.owner || item.sourceUrl);

  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <EntityAvatar label={seed} icon={Icon} size={SIZE_TO_ENTITY[size]} />
      {showSource && hasSource && (
        <span className="ring-background absolute -right-1 -bottom-1 inline-flex rounded-sm ring-2">
          <MarketplaceAvatar
            id={item.marketplaceId}
            owner={item.owner}
            sourceUrl={item.sourceUrl}
            label={item.marketplaceLabel}
            size="xs"
          />
        </span>
      )}
    </span>
  );
}
