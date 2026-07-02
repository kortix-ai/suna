'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { formatDuration } from '@kortix/sdk/turns';
import { cn } from '@/lib/utils';

/**
 * The assistant turn's "pending" shell — the Kortix logomark on top, and beneath
 * it the EXACT regular assistant-waiting indicator (pulsing dot + thinking text +
 * elapsed time, identical to SessionChat's in-turn working row). Rendered the
 * INSTANT a user message is sent so the assistant response area is already
 * present and never "pops in" / spawns late.
 *
 * Shared by SessionChat's optimistic + awaiting states and the instant session
 * shell so all of them render identically (and seamlessly across the shell →
 * chat crossfade).
 */
export function AssistantPendingRow({
  status,
  className,
}: {
  /** Replaces the cycling thinking text (e.g. a retry notice, or a boot stage). */
  status?: ReactNode;
  className?: string;
}) {
  // Elapsed timer — formatted exactly like the in-turn indicator (blank under 1s).
  const startRef = useRef(Date.now());
  const [duration, setDuration] = useState('');
  useEffect(() => {
    const update = () => setDuration(formatDuration(Date.now() - startRef.current));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={cn('flex flex-col items-start gap-3', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kortix-logomark-white.svg"
        alt="Kortix"
        className="dark:invert-0 h-[14px] w-auto flex-shrink-0 invert"
      />
      {/* Regular assistant-waiting row: pulsing dot + thinking text + elapsed —
          identical to SessionChat's in-turn working indicator. */}
      <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
        <span className="relative flex size-3" aria-hidden>
          <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
          <span className="bg-muted-foreground/50 relative inline-flex size-3 rounded-full" />
        </span>
        {status ?? <AnimatedThinkingText className="text-xs" />}
        {duration && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/70">{duration}</span>
          </>
        )}
      </div>
    </div>
  );
}
