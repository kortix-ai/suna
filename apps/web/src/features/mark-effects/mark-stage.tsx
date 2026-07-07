'use client';

import type { CSSProperties, ReactNode, RefObject } from 'react';

import { cn } from '@/lib/utils';

const STAGE_CLASS =
  'relative w-full overflow-hidden rounded-2xl ring-1 ring-black/10 dark:ring-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)]';

/**
 * The framed stage every mark effect sits in — a rounded, ringed, softly
 * shadowed box matching the ripple/mark-ball surfaces. Pass the canvas hook's
 * `containerRef` and render the `<canvas>` (or SVG) as children.
 */
export function MarkStage({
  containerRef,
  children,
  className,
  aspect = 'aspect-[16/9]',
  tone = 'card',
  style,
}: {
  containerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  className?: string;
  aspect?: string;
  tone?: 'card' | 'muted' | 'ink';
  style?: CSSProperties;
}) {
  const toneClass = tone === 'ink' ? 'bg-neutral-950' : tone === 'muted' ? 'bg-muted' : 'bg-card';
  return (
    <div ref={containerRef} className={cn(STAGE_CLASS, aspect, toneClass, className)} style={style}>
      {children}
    </div>
  );
}

export const MARK_CANVAS_CLASS = 'block h-full w-full touch-none select-none';
