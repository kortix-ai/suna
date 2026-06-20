'use client';

import { cn } from '@/lib/utils';
import { motion, useReducedMotion, type Transition } from 'motion/react';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

type IndicatorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const EMPTY_RECT: IndicatorRect = { x: 0, y: 0, width: 0, height: 0 };

export function SlidingTabIndicator({
  activeId,
  indicatorClassName,
  className,
  transition,
  children,
  ...props
}: {
  activeId: string;
  indicatorClassName?: string;
  className?: string;
  transition?: Transition;
  children: ReactNode;
} & ComponentPropsWithoutRef<'div'>) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<IndicatorRect>(EMPTY_RECT);
  const [visible, setVisible] = useState(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const tab = container.querySelector<HTMLElement>(`[data-sliding-tab="${activeId}"]`);
    if (!tab) {
      setVisible(false);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();

    setRect({
      x: tabRect.left - containerRect.left + container.scrollLeft,
      y: tabRect.top - containerRect.top + container.scrollTop,
      width: tabRect.width,
      height: tabRect.height,
    });
    setVisible(true);
  }, [activeId]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => measure());
    ro.observe(container);

    const tabs = container.querySelectorAll<HTMLElement>('[data-sliding-tab]');
    tabs.forEach((tab) => ro.observe(tab));

    window.addEventListener('resize', measure);
    container.addEventListener('scroll', measure, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      container.removeEventListener('scroll', measure);
    };
  }, [measure, activeId]);

  const resolvedTransition = reduceMotion
    ? { duration: 0 }
    : (transition ?? { type: 'spring', stiffness: 380, damping: 32 });

  return (
    <div ref={containerRef} className={cn('relative', className)} {...props}>
      {visible ? (
        <motion.div
          aria-hidden
          className={cn('pointer-events-none absolute top-0 left-0 z-0', indicatorClassName)}
          initial={false}
          animate={{
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }}
          transition={resolvedTransition}
        />
      ) : null}
      {children}
    </div>
  );
}
