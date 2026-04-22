'use client';

import * as React from 'react';
import { UserAvatar, type UserAvatarSize } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';

export interface UserRowProps {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  isSelf?: boolean;
  /** Tint / elevation — 'plain' blends in, 'card' adds a surface card. */
  variant?: 'plain' | 'card';
  size?: UserAvatarSize;
  className?: string;
  onClick?: () => void;
}

export function UserRow({
  email,
  name,
  avatarUrl,
  subtitle,
  trailing,
  isSelf = false,
  variant = 'card',
  size = 'md',
  className,
  onClick,
}: UserRowProps) {
  const displayPrimary = name?.trim() || email;
  const showSecondary = name?.trim() && name.trim() !== email ? email : null;

  const Comp = onClick ? 'button' : 'div';

  return (
    <Comp
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 text-left',
        variant === 'card' &&
          'border-border/60 bg-muted/30 hover:bg-muted/50 rounded-xl border px-3 py-2.5 transition-colors',
        variant === 'plain' && 'px-1 py-1.5',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      <UserAvatar
        email={email}
        name={name}
        avatarUrl={avatarUrl}
        size={size}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">
            {displayPrimary}
          </span>
          {isSelf ? (
            <span className="text-muted-foreground/80 text-[10px] font-medium uppercase tracking-wider">
              · you
            </span>
          ) : null}
        </div>
        {(showSecondary || subtitle) && (
          <div className="text-muted-foreground/80 flex items-center gap-2 truncate text-xs">
            {showSecondary ? <span className="truncate">{showSecondary}</span> : null}
            {showSecondary && subtitle ? <span>·</span> : null}
            {subtitle ? <span className="truncate">{subtitle}</span> : null}
          </div>
        )}
      </div>
      {trailing ? <div className="ml-2 flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </Comp>
  );
}
