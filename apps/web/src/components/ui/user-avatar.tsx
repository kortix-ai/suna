'use client';

import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const PALETTE = [
  'oklch(0.72 0.10 25)',
  'oklch(0.72 0.10 55)',
  'oklch(0.70 0.10 140)',
  'oklch(0.70 0.10 180)',
  'oklch(0.68 0.11 230)',
  'oklch(0.66 0.12 270)',
  'oklch(0.68 0.12 300)',
  'oklch(0.70 0.11 350)',
] as const;

function hashCode(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

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
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-[11px]',
  lg: 'size-10 text-[13px]',
  xl: 'size-14 text-[17px]',
} as const;

export type UserAvatarSize = keyof typeof SIZE_MAP;

export interface UserAvatarProps {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  size?: UserAvatarSize;
  className?: string;
  /** Render a subtle ring so the avatar stands out on dense rows. */
  ring?: boolean;
}

export function UserAvatar({
  email,
  name,
  avatarUrl,
  size = 'md',
  className,
  ring = false,
}: UserAvatarProps) {
  const initials = React.useMemo(
    () => initialsFromIdentity(name ?? undefined, email || ''),
    [name, email],
  );
  const bg = React.useMemo(() => {
    const key = (email || name || 'anon').toLowerCase();
    return PALETTE[hashCode(key) % PALETTE.length];
  }, [email, name]);

  return (
    <Avatar
      className={cn(
        SIZE_MAP[size],
        'shrink-0 font-medium tracking-tight',
        ring && 'ring-background ring-2',
        className,
      )}
    >
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={name || email} /> : null}
      <AvatarFallback
        className="text-white"
        style={{ backgroundColor: bg }}
      >
        {initials || '?'}
      </AvatarFallback>
    </Avatar>
  );
}
