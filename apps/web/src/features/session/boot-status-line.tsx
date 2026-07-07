'use client';

import { useReducedMotion } from 'motion/react';

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';

export const BOOT_STATUS_LABEL = 'Starting your computer…';

/**
 * The ONE boot indicator: a single quiet line with a soft kortix-green pulse and
 * a slow shimmer sweeping the label. Replaces the old 4-step checklist theater
 * everywhere the runtime is coming up (thread, side panel, resume loader).
 * Honors prefers-reduced-motion: reduced-motion users get the steady label (no
 * shimmer), and the pulse dot self-disables via `motion-reduce:animate-none`.
 */
export function BootStatusLine({
  align = 'start',
  className,
}: {
  align?: 'start' | 'center';
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <span
      className={cn(
        'text-muted-foreground/70 inline-flex items-center gap-2 text-[13px] tracking-tight',
        align === 'center' && 'justify-center',
        className,
      )}
      aria-live="polite"
    >
      <span
        className="bg-kortix-green/70 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
        aria-hidden
      />
      {reduceMotion ? (
        <span>{BOOT_STATUS_LABEL}</span>
      ) : (
        <TextShimmer className="text-[13px] tracking-tight" duration={1.5}>
          {BOOT_STATUS_LABEL}
        </TextShimmer>
      )}
    </span>
  );
}
