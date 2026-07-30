'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { formatDuration } from '@kortix/sdk/turns';
import { cn } from '@/lib/utils';

/**
 * The assistant turn's "pending" shell — the Kortix logomark on top, and beneath
 * it a waiting row (pulsing dot + thinking text + elapsed time). Rendered the
 * INSTANT a user message is sent so the assistant response area is already
 * present and never "pops in" / spawns late.
 *
 * This is the PRE-turn counterpart to SessionBusyIndicator, which takes over the
 * same screen position once the first turn materialises. Only the label's
 * x-offset is shared: both land the text 20px from the row's left edge, so the
 * handover does not shift it. Dot size, elapsed placement, and idle-text
 * treatment still differ on purpose — this row keeps a size-3 dot, an inline
 * `· Ns` elapsed, and AnimatedThinkingText's rotating phrases, because before a
 * turn exists there is no real status to report and the rotation is what tells
 * the user the request landed. Unifying the two is a separate change.
 *
 * Shared by SessionChat's optimistic + awaiting states and the instant session
 * shell so all of them render identically (and seamlessly across the shell →
 * chat crossfade).
 */
export function AssistantPendingRow({
  status,
  body,
  className,
}: {
  /** Replaces the cycling thinking text (e.g. a retry notice, or a boot stage). */
  status?: ReactNode;
  /** Replaces the ENTIRE single-line waiting row under the logomark (dot + text +
   *  elapsed) with a custom block — e.g. the inline boot checklist. Keeps the
   *  shared Kortix logomark + spacing so the crossfade to the real chat is seamless. */
  body?: ReactNode;
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
      {/* Pre-turn waiting row: pulsing dot + thinking text + elapsed. The size-3
          dot plus gap-2 puts the label 20px from the left edge — the same offset
          SessionBusyIndicator and every tool row use, so nothing jumps sideways
          when the real turn takes this slot. The dot size, the inline `· Ns`
          elapsed, and the rotating idle text are deliberately NOT the busy
          indicator's. A `body` override swaps this whole row out (e.g. the
          inline boot checklist). */}
      {body ?? (
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
      )}
    </div>
  );
}
