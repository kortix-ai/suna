'use client';

import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface CatalogCardProps {
  leading?: ReactNode;
  title: ReactNode;
  description?: string | null;
  badges?: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CatalogCard({
  leading,
  title,
  description,
  badges,
  trailing,
  onClick,
  disabled,
  className,
  style,
}: CatalogCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={style}
      className={cn(
        'bg-popover group border-border flex w-full items-start gap-3 rounded-md border px-4 py-3.5 text-left',
        'transition-[background-color,border-color] duration-150 ease-out',
        'hover:bg-primary/3 hover:border-border',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-60',
        className,
      )}
    >
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {description ? (
          <span className="text-muted-foreground line-clamp-2 text-xs text-pretty">
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );
}
