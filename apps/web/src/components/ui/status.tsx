'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Kortix status palette — the SINGLE source of truth for "this means
 * success / warning / error / info" coloring.
 *
 * The design system already encapsulates this palette inside `<Badge>` and
 * `<InfoBanner>`. Use those whenever the surface is a chip or a box. But for
 * the cases a component can't cover — a lone status icon, a diff +/- counter,
 * a live activity dot — reach for these maps instead of re-inlining
 * `text-emerald-500` / `bg-red-500/10` / `border-amber-500/30` by hand
 * (which is how shade drift creeps in: emerald-500 vs -600 vs -700).
 *
 * Values mirror badge.tsx / info-banner.tsx exactly so chips, boxes, icons
 * and dots all read as the same green/amber/red/blue.
 */

export type StatusTone =
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'neutral';

/** Foreground (text / icon) color per tone. */
export const STATUS_TEXT: Record<StatusTone, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
  info: 'text-blue-600 dark:text-blue-400',
  neutral: 'text-muted-foreground',
};

/** Faint tinted background per tone (for chips / fills). */
export const STATUS_BG: Record<StatusTone, string> = {
  success: 'bg-emerald-500/10',
  warning: 'bg-amber-500/10',
  destructive: 'bg-destructive/10',
  info: 'bg-blue-500/10',
  neutral: 'bg-muted/50',
};

/** Hairline border per tone (matches InfoBanner edges). */
export const STATUS_BORDER: Record<StatusTone, string> = {
  success: 'border-emerald-500/25',
  warning: 'border-amber-500/30',
  destructive: 'border-destructive/30',
  info: 'border-blue-500/25',
  neutral: 'border-border/60',
};

/** Solid dot fill per tone (for the live activity indicator). */
export const STATUS_DOT: Record<StatusTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  destructive: 'bg-destructive',
  info: 'bg-blue-500',
  neutral: 'bg-muted-foreground/40',
};

/**
 * A faint, tone-based status chip — the member of the status family for
 * "this row/item is success/warning/error/info" labels.
 *
 * Use this (not `<Badge variant="destructive">`) for INFORMATIONAL status,
 * because Badge's `destructive` variant is a SOLID red pill meant for
 * actions — and "red is the brake, not the paint". StatusBadge keeps red
 * faint and consistent with its success/warning/info siblings, sharing the
 * same tone vocabulary as StatusDot / InfoBanner / DiffStat. Geometry matches
 * `<Badge size="sm">` so the two are visually interchangeable for non-red tones.
 */
export function StatusBadge({
  tone = 'neutral',
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="status-badge"
      className={cn(
        'inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-2xl px-2 py-0.5 text-xs font-medium',
        STATUS_BG[tone],
        STATUS_TEXT[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * A small solid status dot — the canonical replacement for hand-rolled
 * `bg-emerald-500 animate-pulse` indicators.
 */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  className,
}: {
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      data-slot="status-dot"
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        STATUS_DOT[tone],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

/**
 * Diff line-count summary — `+12 −3` in the DS success / destructive colors.
 * Renders nothing when both counts are zero/absent.
 */
export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions?: number;
  deletions?: number;
  className?: string;
}) {
  if (!additions && !deletions) return null;
  return (
    <span
      data-slot="diff-stat"
      className={cn(
        'inline-flex items-center gap-1.5 font-mono tabular-nums',
        className,
      )}
    >
      {additions ? (
        <span className={STATUS_TEXT.success}>+{additions}</span>
      ) : null}
      {deletions ? (
        <span className={STATUS_TEXT.destructive}>&minus;{deletions}</span>
      ) : null}
    </span>
  );
}
