'use client';

import { cn } from '@/lib/utils';
import type * as React from 'react';

/**
 * Kortix status palette — the SINGLE source of truth for "this means
 * success / warning / error / info" coloring.
 *
 * The design system already encapsulates this palette inside `<Badge>` and
 * `<InfoBanner>`. Use those whenever the surface is a chip or a box. But for
 * the cases a component can't cover — a lone status icon, a diff +/- counter,
 * a live activity dot — reach for these maps instead of re-inlining a palette
 * class by hand (which is how shade drift creeps in).
 *
 * Hues follow D5 (kortix-brand color.md): success = kortix-green, warning =
 * kortix-orange, destructive = kortix-red, info = kortix-blue. Accents fail AA
 * as body text on white, so STATUS_TEXT paints glyphs and counters only; a
 * label beside the glyph stays foreground.
 */

export type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral';

/** Foreground (text / icon) color per tone. */
export const STATUS_TEXT: Record<StatusTone, string> = {
  success: 'text-kortix-green',
  warning: 'text-kortix-orange',
  destructive: 'text-kortix-red',
  info: 'text-kortix-blue',
  neutral: 'text-muted-foreground',
};

/** Faint tinted background per tone (for chips / fills). */
export const STATUS_BG: Record<StatusTone, string> = {
  success: 'bg-kortix-green/15',
  warning: 'bg-kortix-orange/15',
  destructive: 'bg-kortix-red/15',
  info: 'bg-kortix-blue/15',
  neutral: 'bg-popover',
};

/** Solid hairline border per tone. */
export const STATUS_BORDER: Record<StatusTone, string> = {
  success: 'border-kortix-green',
  warning: 'border-kortix-orange',
  destructive: 'border-kortix-red',
  info: 'border-kortix-blue',
  neutral: 'border-border',
};

/** Solid dot fill per tone (for the live activity indicator). */
export const STATUS_DOT: Record<StatusTone, string> = {
  success: 'bg-kortix-green',
  warning: 'bg-kortix-orange',
  destructive: 'bg-kortix-red',
  info: 'bg-kortix-blue',
  neutral: 'bg-muted-foreground',
};

/** Tone color for an svg glyph inside a chip. The chip label stays foreground. */
const STATUS_CHIP_GLYPH: Record<StatusTone, string> = {
  success: '[&>svg]:text-kortix-green',
  warning: '[&>svg]:text-kortix-orange',
  destructive: '[&>svg]:text-kortix-red',
  info: '[&>svg]:text-kortix-blue',
  neutral: '[&>svg]:text-muted-foreground',
};

export function statusText(tone: StatusTone) {
  return STATUS_TEXT[tone];
}

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
        'text-foreground inline-flex w-fit items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_BG[tone],
        STATUS_CHIP_GLYPH[tone],
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
        'inline-block size-2 shrink-0 rounded-full',
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
      className={cn('inline-flex items-center gap-1.5 font-mono tabular-nums', className)}
    >
      {additions ? <span className={STATUS_TEXT.success}>+{additions}</span> : null}
      {deletions ? <span className={STATUS_TEXT.destructive}>{`−${deletions}`}</span> : null}
    </span>
  );
}
