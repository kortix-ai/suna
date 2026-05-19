'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../../lib/utils';
import { springs } from '../../lib/motion';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface MenuHighlightProps {
  highlightSelector?: string;
  className?: string;
}

export function MenuHighlight({
  highlightSelector = '[data-highlighted]',
  className,
}: MenuHighlightProps) {
  const sentinelRef = React.useRef<HTMLSpanElement>(null);
  const [rect, setRect] = React.useState<Rect | null>(null);

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const container = sentinel.parentElement;
    if (!container) return;

    const measure = () => {
      const highlighted = container.querySelector<HTMLElement>(highlightSelector);
      if (!highlighted || !container.contains(highlighted)) {
        setRect(null);
        return;
      }
      setRect({
        top: highlighted.offsetTop,
        left: highlighted.offsetLeft,
        width: highlighted.offsetWidth,
        height: highlighted.offsetHeight,
      });
    };

    measure();

    const observer = new MutationObserver(measure);
    observer.observe(container, {
      attributes: true,
      attributeFilter: ['data-highlighted', 'data-state', 'data-selected', 'aria-selected'],
      subtree: true,
      childList: true,
    });

    const ro = new ResizeObserver(measure);
    ro.observe(container);

    return () => {
      observer.disconnect();
      ro.disconnect();
    };
  }, [highlightSelector]);

  return (
    <>
      <span ref={sentinelRef} aria-hidden className="hidden" />
      <AnimatePresence>
        {rect ? (
          <motion.div
            key="menu-highlight"
            aria-hidden
            className={cn('pointer-events-none absolute z-0 rounded-md bg-accent', className)}
            initial={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              opacity: 0,
            }}
            animate={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              opacity: 1,
            }}
            exit={{ opacity: 0 }}
            transition={springs.moderate}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
