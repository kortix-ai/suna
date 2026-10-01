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

type Box = { left: number; top: number; width: number; height: number };

/**
 * The tab's rect in the container's own untransformed coordinate space, or
 * `null` while the container has no layout box.
 *
 * `getBoundingClientRect` reports TRANSFORMED geometry; the indicator is
 * positioned in layout space. Divide the transform back out, or a scaled
 * ancestor bakes its scale into the saved rect.
 *
 * This is not hypothetical. `Modal`/`Dialog` open with
 * `data-[state=open]:zoom-in-95`, and the measuring layout effect runs while
 * that animation is on its first frames — so the pill was saved at 95% and
 * stayed there. `ResizeObserver` cannot rescue it: it reports border-box
 * LAYOUT size, which a transform never changes, so it never fires when the
 * animation lands on `scale(1)`. Measured in a dialog at 1280px: the pill sat
 * 4.5px left and 3.7px narrow of its tab, indefinitely — until an unrelated
 * re-measure (clicking another tab) happened to run unscaled.
 *
 * `layout` is the container's border box from `getComputedStyle`, which is
 * fractional. It must not be `offsetWidth`/`offsetHeight`: those round to whole
 * pixels, and every track here is a fraction wide (`--spacing` is 0.23rem). A
 * 258.61px track divided by its rounded 259 is a scale of 0.9985, which pushed
 * the pill right and widened it in proportion to its distance from the left
 * edge — nothing on the first tab, 0.37px on the last of three, enough to put
 * the chip's ring on the track's right edge.
 *
 * An unscaled rect is also snapped to device pixels, edge by edge, the way the
 * browser snaps the tab's own box. The tab sits at a fractional offset and the
 * pill is moved there by a transform, which the browser does not snap: the
 * pill's ring blurred across two pixels and ate the track beside it, while the
 * track and the first tab stayed sharp. Whole device pixels for the offset and
 * the size make the pill land on exactly the pixels the tab covers.
 */
export function toLayoutRect(
  container: Box,
  tab: Box,
  layout: { width: number; height: number },
  scroll: { left: number; top: number },
  dpr = 1,
): IndicatorRect | null {
  const scaleX = layout.width > 0 ? container.width / layout.width : 0;
  const scaleY = layout.height > 0 ? container.height / layout.height : 0;
  if (!scaleX || !scaleY) return null;

  // A computed size is serialized to a few decimals, so an unscaled ratio is
  // 1 within ~1e-5. A real transform (`zoom-in-95`) is far outside this.
  if (Math.abs(scaleX - 1) < 1e-4 && Math.abs(scaleY - 1) < 1e-4) {
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const left = snap(tab.left);
    const top = snap(tab.top);
    return {
      x: left - snap(container.left) + scroll.left,
      y: top - snap(container.top) + scroll.top,
      width: snap(tab.left + tab.width) - left,
      height: snap(tab.top + tab.height) - top,
    };
  }

  return {
    x: (tab.left - container.left) / scaleX + scroll.left,
    y: (tab.top - container.top) / scaleY + scroll.top,
    width: tab.width / scaleX,
    height: tab.height / scaleY,
  };
}

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

    // Preflight makes every box `border-box`, so the computed width and height
    // are the border box — the same box `getBoundingClientRect` measures.
    const style = getComputedStyle(container);
    const next = toLayoutRect(
      container.getBoundingClientRect(),
      tab.getBoundingClientRect(),
      { width: parseFloat(style.width), height: parseFloat(style.height) },
      { left: container.scrollLeft, top: container.scrollTop },
      window.devicePixelRatio,
    );

    // No layout box yet (an unmounted or `display:none` ancestor). Showing a
    // pill from a zero rect draws it at 0×0 in the corner; wait for the
    // ResizeObserver below, which DOES fire for a real size change.
    if (!next) {
      setVisible(false);
      return;
    }

    setRect(next);
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
