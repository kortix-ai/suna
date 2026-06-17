'use client';

import type { Icon } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';
import { IconType } from 'react-icons/lib';

const SIZE_MAP = {
  xs: { box: 'size-5 rounded-sm text-xs', icon: 'size-3' },
  sm: { box: 'size-6 rounded-sm text-xs', icon: 'size-3.5' },
  md: { box: 'size-8 rounded-md text-xs', icon: 'size-4' },
  lg: { box: 'size-10 rounded-md text-sm', icon: 'size-5' },
  xl: { box: 'size-14 rounded-md text-base', icon: 'size-7' },
} as const;

export type EntityAvatarSize = keyof typeof SIZE_MAP;

// FNV-1a-ish string hash → stable 32-bit int. Same label always hashes the same,
// so an entity keeps its color across renders/sessions.
function hashLabel(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface ChalkColors {
  background: string;
  foreground: string;
  border: string;
}

/**
 * Generate a soft, dusty "chalk" color from a label.
 *
 * Chalk = low-ish saturation + high lightness pastel (the sidewalk-chalk look).
 * The hue is derived from the label hash so the result is random-feeling across
 * different labels but deterministic for any given one. A small saturation/
 * lightness wobble (also seeded) keeps neighbouring hues from looking identical.
 */
export function chalkColors(label: string): ChalkColors {
  const hash = hashLabel(label || '?');
  const hue = hash % 360;
  // Seeded wobble so two labels on a similar hue still feel distinct.
  const sat = 65 + (hash % 12); // 65–76%  → chalky, hue reads clearly
  const lift = (hash >> 3) % 5; // 0–4
  return {
    background: `hsl(${hue} ${sat}% ${77 + lift}%)`, // chalk fill (visible, not washed out)
    foreground: `hsl(${hue} ${Math.min(sat + 10, 82)}% 27%)`, // same-hue ink, readable
    border: `hsl(${hue} ${sat}% ${65 + lift}%)`, // hairline, one notch darker
  };
}

export interface EntityAvatarProps {
  label?: string;
  icon?: Icon | IconType;
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
  const chalk = chalkColors(`${label?.trim()}-colors` || initial);

  return (
    <span
      data-slot="entity-avatar"
      style={{
        backgroundColor: chalk.background,
        color: chalk.foreground,
        borderColor: chalk.border,
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-semibold',
        sizes.box,
        className,
      )}
    >
      {IconComponent ? <IconComponent className={sizes.icon} /> : initial}
    </span>
  );
}
