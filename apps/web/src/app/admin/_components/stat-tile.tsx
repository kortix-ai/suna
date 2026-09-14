'use client';

import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Tone for a stat's VALUE. Only ever a `kortix-*` accent, and only when the
 * number itself carries a verdict — an error count that is zero is not green,
 * it is just a number, so `default` is the honest answer far more often than
 * it looks. `idle` / `neutral` has no hue at all
 * (`kortix-brand-guidelines` → Brand accents).
 */
export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<StatTone, string> = {
  default: 'text-foreground',
  success: 'text-kortix-green',
  warning: 'text-kortix-orange',
  danger: 'text-kortix-red',
  info: 'text-kortix-blue',
};

/**
 * One number an operator reads at a glance.
 *
 * Flat — border, no shadow — because it sits in page flow. The label is
 * sentence case at `text-xs`; the previous revision used a letter-spaced
 * uppercase eyebrow, which is a rejected default and, at 13px with `tracking-wider`,
 * measurably slower to read than the sentence case it replaced.
 *
 * The value is `tabular-nums` so a column of tiles keeps its digits aligned
 * while a poll updates them.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <div className={cn('bg-popover min-w-0 rounded-md border px-4 py-3', className)}>
      <div className="text-muted-foreground truncate text-xs">{label}</div>
      <div className={cn('mt-1 truncate text-xl font-medium tabular-nums', TONE[tone])}>{value}</div>
      {hint != null && <div className="text-muted-foreground mt-0.5 truncate text-xs">{hint}</div>}
    </div>
  );
}

/** The tile row. Two up on a small screen, four up from `lg`. */
export function StatGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-2 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
  );
}

/**
 * Shape-matched placeholder for {@link StatGrid}. `h-[70px]` is the tile's own
 * resolved height (`py-3` + label + value + hint at this app's 0.23rem spacing),
 * so the row does not resize when the numbers land.
 */
export function StatGridSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <StatGrid className={className}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-[70px] rounded-md" />
      ))}
    </StatGrid>
  );
}
