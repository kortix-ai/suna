'use client';

/**
 * A title that types itself in when it changes.
 *
 * The sessions list shows "New session" the moment a session is created, then
 * swaps it for the real name seconds later when the agent has one. That swap
 * used to be an instant text replacement — the row simply said something
 * different on the next frame, with nothing to say a value had been written.
 * Typing it says so.
 *
 * TWO PIECES on purpose. `useTypeOnChange` is the trigger and is shared, so
 * every list agrees on WHEN a title types. `TypedTitle` is one rendering of it,
 * for rows that show a title as plain inline text. The sidebar renders its own
 * (it wraps the title in a hover-scrolling marquee) and takes only the hook —
 * shared decision, surface-specific presentation.
 */

import { TypingAnimation } from '@/components/ui/typing-animation';
import { shouldTypeOnChange, TYPE_SPEED_MS } from '@/components/ui/typed-title-logic';
import { cn } from '@/lib/utils';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

export { TYPE_SPEED_MS };

export function useTypeOnChange(text: string): {
  isTyping: boolean;
  /** Remount key for the typing element. A run must restart from character
   *  zero when the title changes again mid-type — without a changing key the
   *  animation keeps its old progress and types the tail of a string nobody
   *  asked for. */
  runId: number;
  /** Hand to the animation's `onComplete`. */
  stop: () => void;
} {
  // The last value this row DISPLAYED, in a ref rather than state: it must not
  // itself cause a render, and it has to update in the same pass that decides
  // to animate, or a second change arriving mid-type compares against a stale
  // value and is missed.
  const previousRef = useRef<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [runId, setRunId] = useState(0);
  const reduceMotion = !!useReducedMotion();

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = text;
    if (!shouldTypeOnChange({ previous, next: text, reduceMotion })) return;
    setIsTyping(true);
    setRunId((id) => id + 1);
  }, [text, reduceMotion]);

  const stop = useCallback(() => setIsTyping(false), []);

  return { isTyping, runId, stop };
}

/**
 * Inline typed title for a list row.
 *
 * Renders as plain text at rest — no wrapper, no extra element — so a row that
 * is not animating costs exactly what it did before, and the parent's
 * `truncate` keeps ellipsising long titles as it always has.
 */
export function TypedTitle({ text, className }: { text: string; className?: string }) {
  const { isTyping, runId, stop } = useTypeOnChange(text);

  if (!isTyping) return <span className={className}>{text}</span>;

  return (
    <TypingAnimation
      key={runId}
      // The row is already on screen and the title has already changed —
      // waiting for an intersection observer would mean a visible row types
      // late, or a row scrolled past types nothing at all.
      startOnView={false}
      showCursor
      blinkCursor
      cursorStyle="line"
      typeSpeed={TYPE_SPEED_MS}
      onComplete={stop}
      // The component ships marketing-hero defaults (`leading-20`, negative
      // tracking) that belong to a headline, not a 13px list row. Reset both
      // so the typed text sits on the same baseline and rhythm as the plain
      // text it replaces — any drift here reads as the row twitching when the
      // animation starts and again when it ends.
      className={cn('leading-none tracking-normal', className)}
    >
      {text}
    </TypingAnimation>
  );
}
