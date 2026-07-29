'use client';

import { cn } from '@/lib/utils';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Frosted isometric glass slabs — the illustration language on the landing
 * page. Built from stacked box-shadows (the extruded side wall) plus a sheen
 * layer, tinted from --kortix-blue so it holds in both themes.
 */

/** Isometric camera. Children are positioned from the centre of this box. */
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
    <div
      className={cn('relative', className)}
      style={{ perspective: '1800px' }}
      aria-hidden
      data-a11y-decorative
    >
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

export function Slab({
  size = 210,
  lift = 0,
  thickness = 16,
  tone = 'frost',
  hidden = false,
  glyph,
}: {
  size?: number;
  lift?: number;
  thickness?: number;
  tone?: 'frost' | 'accent';
  hidden?: boolean;
  glyph?: ReactNode;
}) {
  const edge =
    tone === 'accent'
      ? 'color-mix(in oklab, var(--kortix-blue) 42%, var(--background))'
      : 'color-mix(in oklab, var(--kortix-blue) 11%, var(--background))';

  // one box-shadow per pixel of thickness fakes a solid extruded wall
  const wall = Array.from({ length: thickness }, (_, i) => `0 ${i + 1}px 0 ${edge}`).join(', ');

  return (
    <div
      className="absolute top-0 left-0 rounded-[16px] transition-all duration-[600ms] ease-out"
      style={{
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        transform: `translateZ(${lift}px)`,
        opacity: hidden ? 0 : 1,
        background:
          tone === 'accent'
            ? 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 38%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 20%, var(--background)) 100%)'
            : 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 6%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 2%, var(--background)) 100%)',
        boxShadow: `${wall}, 0 ${thickness + 22}px 34px -8px color-mix(in oklab, var(--kortix-blue) 26%, transparent)`,
        border: '1px solid color-mix(in oklab, var(--kortix-blue) 16%, transparent)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-[15px]"
        style={{
          background:
            'linear-gradient(145deg, color-mix(in oklab, white 60%, transparent) 0%, transparent 48%)',
        }}
      />
      {glyph && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            color:
              tone === 'accent'
                ? 'color-mix(in oklab, var(--kortix-blue) 55%, var(--background))'
                : 'color-mix(in oklab, var(--kortix-blue) 20%, var(--background))',
            filter:
              'drop-shadow(0 1.5px 0 color-mix(in oklab, white 75%, transparent)) drop-shadow(0 -1px 0 color-mix(in oklab, var(--kortix-blue) 35%, transparent))',
          }}
        >
          {glyph}
        </div>
      )}
    </div>
  );
}

/** Small stacked-slab mark for cards. */
export function SlabMark({
  count = 3,
  tone = 'frost',
  className,
  glyph,
}: {
  count?: number;
  tone?: 'frost' | 'accent';
  className?: string;
  glyph?: ReactNode;
}) {
  return (
    <Iso className={cn('h-28 w-full', className)} scale={0.42}>
      {Array.from({ length: count }, (_, i) => `slab-${i}`).map((id, i) => (
        <Slab
          key={id}
          lift={i * 30}
          thickness={12}
          tone={i === count - 1 ? tone : 'frost'}
          glyph={i === count - 1 ? glyph : undefined}
        />
      ))}
    </Iso>
  );
}

/** Wide isometric tile field used behind the closing CTA. */
export function TileField({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      data-a11y-decorative
      className={cn('pointer-events-none overflow-hidden', className)}
      style={{ perspective: '1400px', ...style }}
    >
      <div
        className="absolute top-1/2 left-1/2 grid grid-cols-6 gap-2.5"
        style={{ transform: 'translate(-50%,-50%) rotateX(56deg) rotateZ(-45deg)' }}
      >
        {Array.from({ length: 36 }, (_, i) => `tile-${i}`).map((id, i) => {
          const hot = i % 7 === 0 || i % 11 === 4;
          return (
            <div
              key={id}
              className="size-[4.5rem] rounded-[10px]"
              style={{
                background: hot
                  ? 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 42%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 24%, var(--background)) 100%)'
                  : 'linear-gradient(145deg, color-mix(in oklab, var(--kortix-blue) 8%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 3%, var(--background)) 100%)',
                border: '1px solid color-mix(in oklab, var(--kortix-blue) 14%, transparent)',
                boxShadow: `0 1px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background)), 0 2px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background)), 0 3px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background)), 0 4px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background)), 0 5px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background)), 0 6px 0 color-mix(in oklab, var(--kortix-blue) ${hot ? 30 : 10}%, var(--background))`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
