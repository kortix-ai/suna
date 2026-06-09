'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CliTerminal } from './cli-terminal';
import type { DemoDirector } from './use-demo-director';

const PANEL_W = 384; // max-w-[24rem]
const PANEL_H = 480; // h-[30rem]

/** How far the panel may extend past each edge of the parent. */
const OVERFLOW = {
  top: 48,
  right: 128,
  bottom: 48,
  left: 384, // matches original -left-96
} as const;

function clampPosition(x: number, y: number, containerW: number, containerH: number) {
  return {
    x: Math.min(
      Math.max(x, -OVERFLOW.left),
      Math.max(-OVERFLOW.left, containerW - PANEL_W + OVERFLOW.right),
    ),
    y: Math.min(
      Math.max(y, -OVERFLOW.top),
      Math.max(-OVERFLOW.top, containerH - PANEL_H + OVERFLOW.bottom),
    ),
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
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || pos !== null) return;

    const { height } = container.getBoundingClientRect();
    // Match the original absolute placement: -left-96, -bottom-12
    setPos({
      x: -384,
      y: height - PANEL_H + 48,
    });
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

  if (pos === null) return null;

  return (
    <div
      className={cn(
        'absolute z-50 hidden h-[30rem] w-full max-w-[24rem] touch-none select-none lg:flex',
        dragging
          ? 'ring-border/40 z-[60] scale-[1.02] cursor-grabbing shadow-2xl ring-1'
          : 'cursor-grab shadow-lg transition-[transform,box-shadow] duration-150',
      )}
      style={{ left: pos.x, top: pos.y }}
    >
      <CliTerminal
        director={director}
        dragHandleProps={{
          onPointerDown,
          className: cn('cursor-grab touch-none', dragging && 'cursor-grabbing'),
        }}
      />
    </div>
  );
}
