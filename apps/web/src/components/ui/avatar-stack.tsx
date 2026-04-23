'use client';

import * as React from 'react';
import { UserAvatar, type UserAvatarSize } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';

export interface AvatarStackPerson {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface AvatarStackProps {
  people: AvatarStackPerson[];
  max?: number;
  size?: UserAvatarSize;
  className?: string;
  /** Show a "+N" chip when the list exceeds `max`. Defaults to true. */
  showOverflow?: boolean;
}

const OVERFLOW_SIZE_MAP: Record<UserAvatarSize, string> = {
  xs: 'size-5 text-[9px] -ml-1',
  sm: 'size-6 text-[10px] -ml-1.5',
  md: 'size-8 text-[11px] -ml-2',
  lg: 'size-10 text-[13px] -ml-2',
  xl: 'size-14 text-[14px] -ml-3',
};

const STACK_OFFSET_MAP: Record<UserAvatarSize, string> = {
  xs: '-ml-1',
  sm: '-ml-1.5',
  md: '-ml-2',
  lg: '-ml-2',
  xl: '-ml-3',
};

export function AvatarStack({
  people,
  max = 3,
  size = 'sm',
  className,
  showOverflow = true,
}: AvatarStackProps) {
  if (people.length === 0) return null;
  const visible = people.slice(0, max);
  const remaining = people.length - visible.length;

  return (
    <div className={cn('flex items-center', className)}>
      {visible.map((person, i) => (
        <UserAvatar
          key={person.email + i}
          email={person.email}
          name={person.name}
          avatarUrl={person.avatarUrl}
          size={size}
          ring
          className={i === 0 ? '' : STACK_OFFSET_MAP[size]}
        />
      ))}
      {showOverflow && remaining > 0 ? (
        <span
          className={cn(
            'bg-muted text-muted-foreground ring-background inline-flex items-center justify-center rounded-full font-medium ring-2',
            OVERFLOW_SIZE_MAP[size],
          )}
        >
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}
