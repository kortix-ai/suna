'use client';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { TYPE_SPEED_MS, useTypeOnChange } from '@/components/ui/typed-title';
import { TypingAnimation } from '@/components/ui/typing-animation';
import { cn } from '@/lib/utils';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

/** Pixels-per-second for the hover auto-scroll — slow enough to read. */
const MARQUEE_PX_PER_SEC = 48;
const MARQUEE_MIN_MS = 800;
const MARQUEE_MAX_MS = 8_000;
/** Ease-out snap-back when the pointer leaves mid-scroll. */
const MARQUEE_RETURN_MS = 200;
/** Wait before starting the hover scroll so quick passes don't animate. */
const HOVER_SCROLL_DELAY_MS = 600;

function marqueeDurationMs(overflowPx: number): number {
  const raw = (overflowPx / MARQUEE_PX_PER_SEC) * 1000;
  return Math.min(MARQUEE_MAX_MS, Math.max(MARQUEE_MIN_MS, Math.round(raw)));
}

/**
 * Session row title: types in when the name updates; long titles sit in a
 * horizontal FadedScrollArea and auto-scroll on hover so the full string is
 * readable with edge fades.
 */
export function SessionTitle({ title, className }: { title: string; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [shouldScroll, setShouldScroll] = useState(false);
  const reduceMotion = !!useReducedMotion();

  // WHEN a title types is shared with every other list that shows one (see
  // `useTypeOnChange`); only the rendering below belongs to this surface,
  // because the sidebar wraps its title in a hover-scrolling marquee that no
  // other row has. This file used to own both halves and the sessions page
  // owned neither — which is exactly how the two ended up disagreeing.
  const { isTyping, runId, stop } = useTypeOnChange(title);

  // Delay scroll start on hover; cancel if the pointer leaves early.
  useEffect(() => {
    if (!isHovered) {
      setShouldScroll(false);
      return;
    }
    const timeout = window.setTimeout(() => setShouldScroll(true), HOVER_SCROLL_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isHovered]);

  // Reset scroll when the title changes or typing starts so the start stays left-aligned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = 0;
  }, [title, isTyping]);

  // Hover (after delay): auto-scroll to the end.
  // Leave: ease back to the start. Interruptible via effect cleanup.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || reduceMotion || isTyping) return;

    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 1) {
      el.scrollLeft = 0;
      return;
    }

    const from = el.scrollLeft;
    const to = shouldScroll ? maxScroll : 0;
    if (Math.abs(from - to) < 1) return;

    const duration = shouldScroll ? marqueeDurationMs(maxScroll) : MARQUEE_RETURN_MS;
    const startedAt = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      // Linear while reading; strong ease-out on return (Emil: exit snappy).
      const progress = shouldScroll ? t : 1 - (1 - t) ** 3;
      el.scrollLeft = from + (to - from) * progress;
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shouldScroll, isTyping, title, reduceMotion]);

  return (
    <div
      title={title}
      className={cn('flex min-w-0 flex-1 items-center self-stretch text-sm', className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <FadedScrollArea
        ref={scrollRef}
        orientation="horizontal"
        // Inherit the row's --session-row-surface (set on the row for idle /
        // hover / active). Same CSS variable as the row fill → no group-hover
        // lag and no frame where fade and background disagree.
        fadeColor="from-[var(--session-row-surface,var(--sidebar))]"
        rootClassName="min-h-0 w-full min-w-0 flex-1"
        // py-px gives descenders (g/y/p) room inside overflow-y-hidden.
        className="flex items-center py-px"
      >
        {isTyping ? (
          <TypingAnimation
            key={runId}
            startOnView={false}
            showCursor
            blinkCursor
            cursorStyle="line"
            typeSpeed={TYPE_SPEED_MS}
            className="block text-sm leading-5 tracking-normal whitespace-nowrap"
            onComplete={stop}
          >
            {title}
          </TypingAnimation>
        ) : (
          <span className="block text-sm leading-5 whitespace-nowrap">{title}</span>
        )}
      </FadedScrollArea>
    </div>
  );
}
