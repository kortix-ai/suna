'use client';

import { cn } from '@/lib/utils';
import { m, useReducedMotion, type Transition } from 'motion/react';
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

    /**
     * `getBoundingClientRect` reports TRANSFORMED geometry; the indicator is
     * positioned in the container's own untransformed coordinate space. Divide
     * the transform back out, or a scaled ancestor bakes its scale into the
     * saved rect.
     *
     * This is not hypothetical. `Modal`/`Dialog` open with
     * `data-[state=open]:zoom-in-95`, and the measuring layout effect runs
     * while that animation is on its first frames — so the pill was saved at
     * 95% and stayed there. `ResizeObserver` cannot rescue it: it reports
     * border-box LAYOUT size, which a transform never changes, so it never
     * fires when the animation lands on `scale(1)`. Measured in a dialog at
     * 1280px: the pill sat 4.5px left and 3.7px narrow of its tab,
     * indefinitely — until an unrelated re-measure (clicking another tab)
     * happened to run unscaled.
     *
     * `offsetWidth`/`offsetHeight` are layout values and immune to the
     * transform, which makes them the honest denominator.
     */
    const scaleX = container.offsetWidth > 0 ? containerRect.width / container.offsetWidth : 0;
    const scaleY = container.offsetHeight > 0 ? containerRect.height / container.offsetHeight : 0;

    // No layout box yet (an unmounted or `display:none` ancestor). Showing a
    // pill from a zero rect draws it at 0×0 in the corner; wait for the
    // ResizeObserver below, which DOES fire for a real size change.
    if (!scaleX || !scaleY) {
      setVisible(false);
      return;
    }

    setRect({
      x: (tabRect.left - containerRect.left) / scaleX + container.scrollLeft,
      y: (tabRect.top - containerRect.top) / scaleY + container.scrollTop,
      width: tabRect.width / scaleX,
      height: tabRect.height / scaleY,
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
        <m.div
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
