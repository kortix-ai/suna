'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';

export function List({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-slot="list" className={cn('divide-border/60 divide-y', className)} {...props} />;
}

export interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  badges?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  compact?: boolean;
}

export function ListRow({
  leading,
  title,
  badges,
  subtitle,
  trailing,
  onClick,
  className,
  compact,
}: ListRowProps) {
  const interactive = !!onClick;

  return (
    <li>
      <div
        {...(interactive
          ? {
              role: 'button',
              tabIndex: 0,
              onClick,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick?.();
                }
              },
            }
          : {})}
        className={cn(
          'group flex items-center gap-3 px-6 py-3',
          interactive &&
            'hover:bg-muted/40 focus-visible:bg-muted/40 cursor-pointer transition-colors focus-visible:outline-none',
          className,
        )}
      >
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-foreground truncate text-sm font-medium',
                compact && 'leading-none',
              )}
            >
              {title}
            </span>
            {badges}
          </div>
          {subtitle ? (
            <div className={cn(compact ? 'text-xs leading-none' : 'mt-0.5')}>{subtitle}</div>
          ) : null}
        </div>
        {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
      </div>
    </li>
  );
}
