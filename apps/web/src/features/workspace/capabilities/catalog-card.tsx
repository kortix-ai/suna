'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface CatalogCardProps {
  /** A `size-9 rounded-sm` tile — a `next/image` favicon for connectors, a
   *  tinted glyph tile for skills and commands. Sizing/rounding is the
   *  caller's responsibility; this component only positions the slot. */
  leading: ReactNode;
  title: ReactNode;
  description?: string | null;
  badges?: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * The one card shared by the connectors, skills, and commands catalog grids.
 *
 * A real `<button type="button">`, not a `div` with `onClick` — it must be
 * keyboard-reachable (Tab + Enter/Space) and announce as interactive to
 * assistive tech, which a click handler on a `div` does not give for free.
 *
 * No `active:scale` here. Scale-on-press (`make-interfaces-feel-better`) is
 * calibrated for ~32px controls; on a ~320px catalog card it reads as the
 * whole page flexing rather than a button depressing. Press feedback belongs
 * on the smaller buttons nested inside a card's `trailing` slot, not the
 * card itself — do not add it back here.
 */
export function CatalogCard({
  leading,
  title,
  description,
  badges,
  trailing,
  onClick,
  disabled,
}: CatalogCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'bg-popover group flex w-full items-start gap-3 rounded-md border px-4 py-3.5 text-left',
        'transition-[background-color,border-color] duration-150 ease-out',
        'hover:bg-primary/[0.03] hover:border-border',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-60',
      )}
    >
      <span className="shrink-0">{leading}</span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {description ? (
          <span className="text-muted-foreground line-clamp-2 block text-xs text-pretty">
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );
}
