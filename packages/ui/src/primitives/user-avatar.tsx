'use client';

import { Hint } from './hint';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { cn } from '../lib/utils';
import { AVATAR_INK, avatarFill } from '@kortix/shared';
import * as React from 'react';

function initialsFromIdentity(name: string | undefined, email: string): string {
  const source = (name || '').trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const second = parts.length > 1 ? parts[parts.length - 1]?.[0] : '';
    const out = (first + second).toUpperCase();
    if (out) return out;
  }
  const local = email.split('@')[0] ?? email;
  const segments = local.split(/[._-]+/).filter(Boolean);
  const first = segments[0]?.[0] ?? local[0] ?? '?';
  const second = segments[1]?.[0] ?? '';
  return (first + second).toUpperCase();
}

/**
 * `text` goes on the fallback itself: the primitive's fallback sets its own
 * `text-sm`, which beat a size class on the root. Two initials at 14px
 * semibold filled the 22px `sm` tile edge to edge and overflowed an 18px one.
 * `xs` and `sm` hold ONE initial, as EntityAvatar does: `text-xs` (13px) is
 * the floor of the type scale, and two letters at 13px still fill an 18px tile.
 */
const SIZE_MAP = {
  xs: { box: 'size-5', text: 'text-xs', initials: 1 },
  sm: { box: 'size-6', text: 'text-xs', initials: 1 },
  md: { box: 'size-8', text: 'text-xs', initials: 2 },
  lg: { box: 'size-10', text: 'text-sm', initials: 2 },
  xl: { box: 'size-14', text: 'text-base', initials: 2 },
} as const;

export type UserAvatarSize = keyof typeof SIZE_MAP;

export interface UserAvatarProps {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  size?: UserAvatarSize;
  className?: string;
  ring?: boolean;
  variant?: 'default' | 'primary';
  /** Shows on hover, through `Hint`: usually the person's name or email. */
  hint?: React.ReactNode;
}

export function UserAvatar({
  hint,
  email,
  name,
  avatarUrl,
  size = 'md',
  variant = 'default',
  className,
  ring = false,
}: UserAvatarProps) {
  const sizes = SIZE_MAP[size] ?? SIZE_MAP.md;
  const initials = React.useMemo(
    () => initialsFromIdentity(name ?? undefined, email || '').slice(0, sizes.initials),
    [name, email, sizes.initials],
  );
  // Avatar v2: a solid fill keyed on the email, so a rename keeps the colour.
  const fill = avatarFill(email || name || '');

  const avatar = (
    <Avatar
      className={cn(
        sizes.box,
        'shrink-0 overflow-hidden rounded-sm p-0 font-medium',
        ring && 'ring-background ring-2',
        // A photo keeps an edge on a light page: a 1px inset hairline over it.
        avatarUrl &&
          'after:ring-border after:pointer-events-none after:absolute after:inset-0 after:rounded-sm after:ring-1 after:ring-inset',
        variant === 'primary' && 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={name || email} /> : null}
      <AvatarFallback
        className={cn('rounded-sm font-medium', sizes.text)}
        style={{ backgroundColor: fill, color: AVATAR_INK }}
      >
        {initials || '?'}
      </AvatarFallback>
    </Avatar>
  );
  return hint ? (
    <Hint side="top" sideOffset={6} alignOffset={0} label={hint}>
      {avatar}
    </Hint>
  ) : (
    avatar
  );
}
