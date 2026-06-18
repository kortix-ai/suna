'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const FadedScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    fadeColor?: string;
  }
>(function FadedScrollArea({ children, className, fadeColor = 'from-sidebar' }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

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
    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScroll = scrollHeight - clientHeight;
    const canScroll = maxScroll > 1;
    if (!canScroll) {
      setShowTopFade(false);
      setShowBottomFade(false);
      return;
    }
    setShowTopFade(scrollTop > 1);
    setShowBottomFade(scrollTop < maxScroll - 1);
  }, []);

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
    <div className="relative">
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b to-transparent transition-opacity',
          fadeColor,
          showTopFade ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-gradient-to-t to-transparent transition-opacity',
          fadeColor,
          showBottomFade ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />
      <div
        ref={setScrollRef}
        className={cn('scrollbar-hide h-full min-h-0 flex-1 overflow-y-auto pb-0', className)}
      >
        {children}
      </div>
    </div>
  );
});

FadedScrollArea.displayName = 'FadedScrollArea';
