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

const SIZES = {
  sm: { box: 'size-8 rounded-lg', icon: 'size-4' },
  md: { box: 'size-10 rounded-xl', icon: 'size-5' },
  lg: { box: 'size-14 rounded-2xl', icon: 'size-7' },
} as const;

/** Stable 32-bit hash of a string (same family as MarketplaceAvatar's hueOf). */
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
 * icon + hue from the item's name — so two skills never look alike — and pins
 * the source's favicon/avatar as a small corner badge for provenance. The
 * "icon first, favicon second" heuristic: a generated mark up front, the real
 * source mark riding the corner. All deterministic — no flash, no layout shift.
 */
export function MarketplaceItemAvatar({
  item,
  size = 'md',
  showSource = true,
  className,
}: {
  item: ItemLike;
  size?: keyof typeof SIZES;
  /** Render the source favicon corner badge (hide when already browsing one source). */
  showSource?: boolean;
  className?: string;
}) {
  const s = SIZES[size];
  const seed = item.name || item.id;
  const h = hashOf(seed);
  const Icon = ICON_POOL[h % ICON_POOL.length];
  // Decorrelate hue from the icon index so colour and glyph vary independently.
  const hue = Math.floor(h / ICON_POOL.length) % 360;
  const hasSource = !!(item.owner || item.sourceUrl);

  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn('inline-flex items-center justify-center', s.box)}
        style={{ backgroundColor: `hsl(${hue} 64% 50% / 0.14)`, color: `hsl(${hue} 52% 52%)` }}
        aria-hidden
      >
        <Icon className={s.icon} />
      </span>
      {showSource && hasSource && (
        <span className="ring-card absolute -right-1 -bottom-1 inline-flex rounded ring-2">
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
