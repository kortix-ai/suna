import {
  Bot,
  FileText,
  Package,
  ScrollText,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface TypeMeta {
  label: string;
  Icon: LucideIcon;
  /** Tinted tile classes (bg + text) — gives each type a recognizable color. */
  tile: string;
}

const NEUTRAL = 'bg-foreground/5 text-muted-foreground';

const TYPE_META: Record<string, TypeMeta> = {
  'registry:skill': { label: 'Skill', Icon: Sparkles, tile: 'bg-kortix-blue/10 text-kortix-blue' },
  'registry:agent': { label: 'Agent', Icon: Bot, tile: 'bg-kortix-purple/10 text-kortix-purple' },
  'registry:command': { label: 'Command', Icon: SquareTerminal, tile: 'bg-kortix-green/10 text-kortix-green' },
  'registry:tool': { label: 'Tool', Icon: Wrench, tile: 'bg-kortix-orange/10 text-kortix-orange' },
  'registry:bundle': { label: 'Bundle', Icon: Package, tile: 'bg-kortix-yellow/15 text-kortix-yellow' },
  'registry:rules': { label: 'Rules', Icon: ScrollText, tile: NEUTRAL },
  'registry:file': { label: 'File', Icon: FileText, tile: NEUTRAL },
};

export function typeMeta(type: string): TypeMeta {
  return TYPE_META[type] ?? { label: type.replace('registry:', ''), Icon: FileText, tile: NEUTRAL };
}

const TILE_SIZES = {
  sm: { box: 'size-8 rounded-lg', icon: 'size-4' },
  md: { box: 'size-10 rounded-xl', icon: 'size-5' },
  lg: { box: 'size-14 rounded-2xl', icon: 'size-7' },
} as const;

/** A square, type-colored icon tile (things are square). */
export function TypeTile({
  type,
  size = 'md',
  className,
}: {
  type: string;
  size?: keyof typeof TILE_SIZES;
  className?: string;
}) {
  const { Icon, tile } = typeMeta(type);
  const s = TILE_SIZES[size];
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center', s.box, tile, className)}>
      <Icon className={s.icon} />
    </span>
  );
}

// The one-click importables users browse + install. Filters and grouped
// sections auto-hide any type with no items (marketplace-browser derives
// `typeOptions` from live typeCounts; marketplace-grid only emits a section for
// present items), so listing a type here is safe even before content exists.
export const TYPE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'agent', label: 'Agents' },
  { value: 'command', label: 'Commands' },
  { value: 'bundle', label: 'Bundles' },
];

/** Section order + labels for the grouped (filter=All) gallery view. */
export const TYPE_SECTIONS: Array<{ type: string; label: string }> = [
  { type: 'registry:skill', label: 'Skills' },
  { type: 'registry:agent', label: 'Agents' },
  { type: 'registry:command', label: 'Commands' },
  { type: 'registry:bundle', label: 'Bundles' },
];
