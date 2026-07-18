'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { faviconUrlForValue } from '@/lib/favicon';
import { cn } from '@/lib/utils';
import { Globe } from 'lucide-react';

const SIZE_MAP = {
  xs: { avatar: 'size-5', icon: 'size-3' },
  sm: { avatar: 'size-6', icon: 'size-3.5' },
  md: { avatar: 'size-8', icon: 'size-4' },
  lg: { avatar: 'size-10', icon: 'size-5' },
} as const;

export type FaviconAvatarSize = keyof typeof SIZE_MAP;

export interface FaviconAvatarProps {
  /** Full http(s) URL or bare domain (e.g. google.com). */
  value: string;
  size?: FaviconAvatarSize;
  className?: string;
  alt?: string;
}

export function FaviconAvatar({ value, size = 'xs', className, alt = '' }: FaviconAvatarProps) {
  const sizes = SIZE_MAP[size];
  const src = faviconUrlForValue(value);

  return (
    <Avatar data-slot="favicon-avatar" className={cn('bg-muted/60 rounded', sizes.avatar, className)}>
      {src ? (
        <AvatarImage
          src={src}
          alt={alt}
          className="outline outline-black/10 dark:outline-white/10"
        />
      ) : null}
      <AvatarFallback delayMs={0} className="bg-muted/60">
        <Globe className={cn('text-muted-foreground/50', sizes.icon)} />
      </AvatarFallback>
    </Avatar>
  );
}
