'use client';

import { cn } from '@/lib/utils';

export const BOOT_STATUS_LABEL = 'Starting your computer…';

/**
 * The ONE boot indicator: a single quiet line with a soft kortix-green pulse.
 * Replaces the old 4-step checklist theater everywhere the runtime is coming up
 * (thread, side panel, resume loader). Honors prefers-reduced-motion.
 */
export function BootStatusLine({
  align = 'start',
  className,
}: {
  align?: 'start' | 'center';
  className?: string;
}) {
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
      <span>{BOOT_STATUS_LABEL}</span>
    </span>
  );
}
