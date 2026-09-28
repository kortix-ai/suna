'use client';

import { AppleCursor } from '@/features/icon/icons/apple-cursor';
import { cn } from '@/lib/utils';
import type { CSSProperties, ReactNode } from 'react';
import { interp, rise, stagger, ease } from '../../engine/time';

/** Words rise one after another on a compressing stagger. */
export function Words({
  text,
  f,
  at,
  gap = 4,
  offset = 0,
  className,
}: {
  text: string;
  f: number;
  at: number;
  gap?: number;
  /** Index the first word continues from, so two runs share one stagger. */
  offset?: number;
  className?: string;
}) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        <span
          key={i}
          className={cn('inline-block whitespace-pre', className)}
          style={rise(f, at + stagger(i + offset, gap), { dist: 22, blur: 6 })}
        >
          {word}
          {' '}
        </span>
      ))}
    </>
  );
}

/**
 * The site's two-tone headline: the claim in ink, the qualifier in muted ink,
 * one sentence. Same pattern as the "Every session gets its own computer." copy
 * on kortix.com.
 */
export function Headline({
  lead,
  rest,
  f,
  at,
  className,
  size = 'text-6xl',
  stack = false,
}: {
  lead: string;
  rest?: string;
  f: number;
  at: number;
  className?: string;
  size?: 'text-7xl' | 'text-6xl' | 'text-5xl' | 'text-4xl';
  /** Put the qualifier on its own line. */
  stack?: boolean;
}) {
  const n = lead.split(' ').length;
  return (
    <h2 className={cn('font-medium tracking-tight text-balance', size, 'leading-tight', className)}>
      <Words text={lead} f={f} at={at} className="text-foreground" />
      {stack ? <br /> : null}
      {rest ? <Words text={rest} f={f} at={at + 6} offset={n} className="text-muted-foreground" /> : null}
    </h2>
  );
}

/** A product window: hairline chrome, a mono title, flush content. */
export function Window({
  title,
  aside,
  children,
  className,
  style,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn('bg-popover border-border overflow-hidden rounded-2xl border shadow-2xl', className)}
      style={style}
    >
      <div className="border-border flex items-center gap-3 border-b px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="bg-muted size-2.5 rounded-full" />
          <span className="bg-muted size-2.5 rounded-full" />
          <span className="bg-muted size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground font-mono text-xs">{title}</span>
        <span className="ml-auto">{aside}</span>
      </div>
      {children}
    </div>
  );
}

/** A pointer that travels on `inOutCubic` and presses (0.96) at `press`. */
export function Cursor({
  f,
  from,
  to,
  at,
  arrive,
  press,
}: {
  f: number;
  from: [number, number];
  to: [number, number];
  at: number;
  arrive: number;
  press: number;
}) {
  const x = interp(f, at, arrive, from[0], to[0], ease.inOutCubic);
  const y = interp(f, at, arrive, from[1], to[1], ease.inOutCubic);
  const down = f >= press && f < press + 8;
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-10"
      style={{
        opacity: interp(f, at, at + 10, 0, 1, ease.outQuad),
        transform: `translate3d(${x}px, ${y}px, 0) scale(${down ? 0.88 : 1})`,
      }}
    >
      <AppleCursor className="size-8 drop-shadow-lg" />
    </div>
  );
}

/** Scale for a pressed control: 0.96 for 8 frames, the house press. */
export const pressed = (f: number, at: number) => (f >= at && f < at + 8 ? 0.96 : 1);
