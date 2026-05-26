'use client';

/**
 * UserAvatar — a person (round). The squared counterpart is <EntityAvatar>.
 *
 * Renders the supabase profile picture when one is available (avatar_url /
 * picture, served with referrerPolicy="no-referrer" so Google-hosted images
 * load), and falls back to neutral monochrome initials otherwise. People and
 * things share the same neutral material and size scale — only the shape
 * differs (round vs square). No colored backgrounds: simplicity is the brand.
 */

import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

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
  md: 'size-8 text-xs',
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
      <AvatarFallback className="border border-border/70 bg-muted/40 font-semibold text-foreground/80">
        {initials || '?'}
      </AvatarFallback>
    </Avatar>
  );
}
