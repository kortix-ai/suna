'use client';

import type { Icon } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';

/**
 * Kortix <EntityAvatar> — the squared counterpart to <UserAvatar>.
 *
 * People are round (UserAvatar); *things* — accounts, projects, groups,
 * workspaces — are rounded squares. Keeping the two shapes distinct is the
 * single convention that makes every list legible at a glance. Sizes mirror
 * UserAvatar exactly so people and entities line up on the same row.
 *
 *   <EntityAvatar label="Acme AGI" />          // initial tile
 *   <EntityAvatar icon={IconProject} />        // icon tile
 */

const SIZE_MAP = {
  xs: { box: 'size-5 rounded-sm text-xs', icon: 'h-3 w-3' },
  sm: { box: 'size-6 rounded-sm text-xs', icon: 'h-3.5 w-3.5' },
  md: { box: 'size-8 rounded-md text-xs', icon: 'h-4 w-4' },
  lg: { box: 'size-10 rounded-md text-sm', icon: 'h-5 w-5' },
  xl: { box: 'size-14 rounded-md text-base', icon: 'h-7 w-7' },
} as const;

export type EntityAvatarSize = keyof typeof SIZE_MAP;

export interface EntityAvatarProps {
  /** Text to derive the initial from when no icon is given. */
  label?: string;
  /** Lucide icon to render instead of an initial. */
  icon?: Icon;
  size?: EntityAvatarSize;
  className?: string;
}

export function EntityAvatar({
  label,
  icon: IconComponent,
  size = 'md',
  className,
}: EntityAvatarProps) {
  const sizes = SIZE_MAP[size];
  const initial = (label?.trim()?.charAt(0) || '?').toUpperCase();

  return (
    <span
      data-slot="entity-avatar"
      className={cn(
        'border-border bg-muted/40 text-foreground/80 inline-flex shrink-0 items-center justify-center border font-semibold',
        sizes.box,
        className,
      )}
    >
      {IconComponent ? (
        <IconComponent className={cn(sizes.icon, 'text-muted-foreground')} />
      ) : (
        initial
      )}
    </span>
  );
}
