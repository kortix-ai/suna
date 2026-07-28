'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The illustration language: frosted isometric slabs, extruded with stacked
 * box-shadows and topped with a debossed glyph. Every colour comes from
 * --kortix-blue mixed into the surface tokens, so it holds in both themes.
 */

/** Soft tinted stage the illustrations sit on. */
export function Stage({
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('border-border relative overflow-hidden rounded-sm border', className)}
      style={{
        background:
          'radial-gradient(120% 90% at 50% 0%, color-mix(in oklab, var(--kortix-blue) 9%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 60%, var(--background) 100%)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Isometric scene wrapper — sets the shared camera. */
export function Iso({
  className,
  scale = 1,
  children,
}: {
  className?: string;
  scale?: number;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative', className)} style={{ perspective: '1600px' }} aria-hidden data-a11y-decorative>
      <div
        className="absolute top-1/2 left-1/2"
        style={{
          transformStyle: 'preserve-3d',
          transform: `translate(-50%,-50%) scale(${scale}) rotateX(56deg) rotateZ(-45deg)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * One frosted slab. `lift` raises it in the stack, `thickness` sets the
 * extruded edge, `tone` picks the accent-tinted or plain-frost face.
 */
export function Slab({
  size = 208,
  lift = 0,
  thickness = 14,
  tone = 'frost',
  dim = false,
  glyph,
}: {
  size?: number;
  lift?: number;
  thickness?: number;
  tone?: 'frost' | 'accent';
  dim?: boolean;
  glyph?: ReactNode;
}) {
  // Stacked shadows fake the extruded side wall; the last one is the cast shadow.
  const edge =
    tone === 'accent'
      ? 'color-mix(in oklab, var(--kortix-blue) 34%, var(--background))'
      : 'color-mix(in oklab, var(--kortix-blue) 12%, var(--background))';
  const wall = Array.from({ length: thickness }, (_, i) => `0 ${i + 1}px 0 ${edge}`).join(', ');

  return (
    <div
      className="absolute top-0 left-0 rounded-[14px] transition-all duration-500 ease-out"
      style={{
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        transform: `translateZ(${lift}px)`,
        opacity: dim ? 0 : 1,
        background:
          tone === 'accent'
            ? 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 30%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 16%, var(--background)) 100%)'
            : 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 7%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 2%, var(--background)) 100%)',
        boxShadow: `${wall}, 0 ${thickness + 18}px 30px -6px color-mix(in oklab, var(--kortix-blue) 22%, transparent)`,
        border: '1px solid color-mix(in oklab, var(--kortix-blue) 18%, transparent)',
      }}
    >
      {/* top-face sheen */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[13px]"
        style={{
          background:
            'linear-gradient(145deg, color-mix(in oklab, white 55%, transparent) 0%, transparent 45%)',
        }}
      />
      {glyph && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            color: 'color-mix(in oklab, var(--kortix-blue) 26%, var(--background))',
            filter:
              'drop-shadow(0 1px 0 color-mix(in oklab, white 70%, transparent)) drop-shadow(0 -1px 0 color-mix(in oklab, var(--kortix-blue) 30%, transparent))',
          }}
        >
          {glyph}
        </div>
      )}
    </div>
  );
}

/** A single slab floating on a stage — used for card thumbnails. */
export function SlabMark({
  count = 3,
  tone = 'frost',
  className,
}: {
  count?: number;
  tone?: 'frost' | 'accent';
  className?: string;
}) {
  return (
    <Iso className={cn('h-20 w-full', className)} scale={0.34}>
      {Array.from({ length: count }).map((_, i) => (
        <Slab key={i} lift={i * 26} thickness={10} tone={i === count - 1 ? tone : 'frost'} />
      ))}
    </Iso>
  );
}
