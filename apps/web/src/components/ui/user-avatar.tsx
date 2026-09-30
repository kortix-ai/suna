'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';
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

const SIZE_MAP = {
  xs: 'size-5 text-xs',
  sm: 'size-6 text-xs',
  md: 'size-8 rounded-md text-xs',
  lg: 'size-10 text-sm',
  xl: 'size-14 text-base',
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
  /** `circle` for a person shown beside chat content. */
  shape?: 'square' | 'circle';
  /** How many letters the fallback shows. One fits the `xs` size. */
  initials?: 1 | 2;
}

export function UserAvatar({
  email,
  name,
  avatarUrl,
  size = 'md',
  variant = 'default',
  className,
  ring = false,
  shape = 'square',
  initials: letters = 2,
}: UserAvatarProps) {
  const initials = React.useMemo(
    () => initialsFromIdentity(name ?? undefined, email || '').slice(0, letters),
    [name, email, letters],
  );
  // Keyed on the email when there is no name, so nameless people still differ.
  const chalk = chalkColors(name || email);

  return (
    <Avatar
      className={cn(
        SIZE_MAP[size] ?? 'size-8',
        'shrink-0 overflow-hidden rounded-sm p-0 font-medium tracking-tight',
        shape === 'circle' && 'rounded-full',
        ring && 'ring-background ring-2',
        variant === 'primary' && 'bg-primary text-primary-foreground',
        className,
      )}
    >
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={name || email} /> : null}
      <AvatarFallback
        className={cn(
          'border-border text-foreground border bg-transparent font-semibold',
          shape === 'circle' && 'rounded-full',
          // variant === 'primary' && 'bg-primary text-primary-foreground',
        )}
        style={{
          backgroundColor: chalk.background,
          color: chalk.foreground,
          borderColor: chalk.border,
        }}
      >
        {initials || '?'}
      </AvatarFallback>
    </Avatar>
  );
}
