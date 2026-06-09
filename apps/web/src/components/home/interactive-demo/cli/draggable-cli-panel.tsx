'use client';

import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CliTerminal } from './cli-terminal';
import type { DemoDirector } from './use-demo-director';

const ENTRANCE_DELAY_MS = 2000;

const PANEL_W = 384; // max-w-[24rem]
const PANEL_H = 480; // h-[30rem]

/** How far the panel may extend past each edge of the parent. */
const OVERFLOW = {
  top: 48,
  right: 128,
  bottom: 48,
  left: 384, // matches original -left-96
} as const;

function maxPosition(containerW: number, containerH: number) {
  return {
    x: Math.max(-OVERFLOW.left, containerW - PANEL_W + OVERFLOW.right),
    y: Math.max(-OVERFLOW.top, containerH - PANEL_H + OVERFLOW.bottom),
  };
}

function clampPosition(x: number, y: number, containerW: number, containerH: number) {
  const max = maxPosition(containerW, containerH);
  return {
    x: Math.min(Math.max(x, -OVERFLOW.left), max.x),
    y: Math.min(Math.max(y, -OVERFLOW.top), max.y),
  };
}

export function DraggableCliPanel({
  containerRef,
  director,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  director: DemoDirector;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [entranceReady, setEntranceReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const timer = window.setTimeout(() => setEntranceReady(true), ENTRANCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pos !== null) return;

    const applyInitialPos = () => {
      const { width, height } = container.getBoundingClientRect();
      if (height === 0) return;
      setPos(maxPosition(width, height));
    };

    applyInitialPos();
    const ro = new ResizeObserver(applyInitialPos);
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, pos]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || pos === null) return;

    const ro = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      setPos((current) => (current ? clampPosition(current.x, current.y, width, height) : current));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, pos]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pos || e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);

      const { left, top, width, height } = container.getBoundingClientRect();
      const pointerX = e.clientX - left;
      const pointerY = e.clientY - top;
      dragOffset.current = { x: pointerX - pos.x, y: pointerY - pos.y };

      const onMove = (ev: PointerEvent) => {
        const next = clampPosition(
          ev.clientX - left - dragOffset.current.x,
          ev.clientY - top - dragOffset.current.y,
          width,
          height,
        );
        setPos(next);
      };

      const onUp = (ev: PointerEvent) => {
        setDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* capture may already be released */
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [containerRef, pos],
  );

  if (pos === null || !entranceReady) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className={cn(
        'absolute z-50 hidden h-120 w-full max-w-[24rem] touch-none overflow-hidden rounded-md select-none lg:flex',
        dragging
          ? 'ring-border/40 z-60 scale-[1.02] cursor-grabbing shadow-2xl ring-1'
          : 'cursor-grab shadow-md transition-[transform,box-shadow] duration-150',
      )}
      style={{ left: pos.x, top: pos.y }}
    >
      <CliTerminal
        director={director}
        dragHandleProps={{
          onPointerDown,
          className: cn('cursor-grab touch-none ', dragging && 'cursor-grabbing'),
        }}
      />
    </motion.div>
  );
}
