'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The transcript's LOADING state — placeholder bubbles roughly shaped like a
 * conversation, replaced by the real messages when they land.
 *
 * Loading and generating are two different facts and must not share a visual.
 * "Gathering thoughts…" says the agent is thinking; it is a lie over a session
 * that is merely being read back, and it was what entering a session used to
 * show. This says the opposite thing — the conversation is on its way — and
 * says it in the shape the conversation will take, so the swap reads as content
 * arriving rather than as one widget replacing another.
 *
 * Deliberately NOT animated beyond `Skeleton`'s own shimmer, and deliberately
 * silent: no copy, no spinner, no percentage. A transcript read is normally
 * fast, and anything that narrates it turns a 200ms wait into an event.
 *
 * The alternating widths and the user/assistant alternation are the whole
 * trick. Uniform bars read as a table; a conversation has a visible rhythm —
 * short prompt, longer answer — and matching it is what makes the placeholder
 * legible as "your messages" at a glance.
 */

/** Width classes per row, as a fixed pattern rather than random values: a
 *  remount must not reshuffle the layout, which reads as a second load. */
const ROWS: ReadonlyArray<{ role: 'user' | 'assistant'; widths: readonly string[] }> = [
  { role: 'user', widths: ['w-[42%]'] },
  { role: 'assistant', widths: ['w-[88%]', 'w-[76%]', 'w-[54%]'] },
  { role: 'user', widths: ['w-[31%]'] },
  { role: 'assistant', widths: ['w-[81%]', 'w-[63%]'] },
];

export function SessionTranscriptSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('mx-auto w-full max-w-3xl space-y-8 px-4 py-8', className)}
      data-testid="session-transcript-skeleton"
      // One label for the whole block. Per-line labels would have a screen
      // reader announce four meaningless rows; `busy` is the fact, and the
      // real transcript replaces it.
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      {ROWS.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className={cn(
            'flex flex-col gap-2',
            // The user's own messages sit right-aligned in the thread, so the
            // placeholder has to as well — a left-aligned block that jumps
            // right on load is a worse arrival than no placeholder at all.
            row.role === 'user' ? 'items-end' : 'items-start',
          )}
        >
          {row.widths.map((width, lineIndex) => (
            <Skeleton
              key={lineIndex}
              className={cn(
                'h-4 rounded-md',
                width,
                // The user bubble is a filled surface in the real transcript;
                // the assistant's answer is bare text. Matching that keeps the
                // two distinguishable while they are still placeholders.
                row.role === 'user' && 'h-9 rounded-2xl',
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
