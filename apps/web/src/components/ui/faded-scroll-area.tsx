'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const FadedScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    fadeColor?: string;
    orientation?: 'vertical' | 'horizontal';
  }
>(function FadedScrollArea(
  { children, className, fadeColor = 'from-sidebar', orientation = 'vertical' },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showStartFade, setShowStartFade] = useState(false);
  const [showEndFade, setShowEndFade] = useState(false);
  const isHorizontal = orientation === 'horizontal';

  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (isHorizontal) {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const maxScroll = scrollWidth - clientWidth;
      const canScroll = maxScroll > 1;
      if (!canScroll) {
        setShowStartFade(false);
        setShowEndFade(false);
        return;
      }
      setShowStartFade(scrollLeft > 1);
      setShowEndFade(scrollLeft < maxScroll - 1);
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScroll = scrollHeight - clientHeight;
    const canScroll = maxScroll > 1;
    if (!canScroll) {
      setShowStartFade(false);
      setShowEndFade(false);
      return;
    }
    setShowStartFade(scrollTop > 1);
    setShowEndFade(scrollTop < maxScroll - 1);
  }, [isHorizontal]);

  useLayoutEffect(() => {
    updateScrollFades();
  }, [updateScrollFades]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollFades);
    ro.observe(el);
    el.addEventListener('scroll', updateScrollFades, { passive: true });
    window.addEventListener('resize', updateScrollFades);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollFades);
      window.removeEventListener('resize', updateScrollFades);
    };
  }, [updateScrollFades]);

  return (
    <div
      className={cn(
        'relative flex min-h-0 min-w-0',
        isHorizontal ? 'h-full flex-1' : 'h-full flex-col',
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute z-10 transition-opacity',
          fadeColor,
          isHorizontal
            ? 'inset-y-0 left-0 w-10 bg-gradient-to-r to-transparent'
            : 'inset-x-0 top-0 h-10 bg-gradient-to-b to-transparent',
          showStartFade ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />
      <div
        className={cn(
          'pointer-events-none absolute z-10 transition-opacity',
          fadeColor,
          isHorizontal
            ? 'inset-y-0 right-0 w-10 bg-gradient-to-l to-transparent'
            : 'inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent',
          showEndFade ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />
      <div
        ref={setScrollRef}
        className={cn(
          'scrollbar-hide min-h-0 min-w-0 flex-1 pb-0',
          isHorizontal ? 'overflow-x-auto overflow-y-hidden' : 'overflow-y-auto',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
});

FadedScrollArea.displayName = 'FadedScrollArea';
