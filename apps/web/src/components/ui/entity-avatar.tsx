'use client';

import type { Icon } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';
import { IconType } from 'react-icons/lib';

const SIZE_MAP = {
  xs: { box: 'size-5 rounded-sm text-xs', icon: 'size-3' },
  sm: { box: 'size-6 rounded-sm text-xs', icon: 'size-3.5' },
  md: { box: 'size-8 rounded-md text-xs', icon: 'size-4' },
  lg: { box: 'size-10 rounded-md text-sm', icon: 'size-5' },
  xl: { box: 'size-14 rounded-md text-base', icon: 'size-7' },
} as const;

export type EntityAvatarSize = keyof typeof SIZE_MAP;

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
  const chalk = chalkColors(`${label?.trim()}` || initial);

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
