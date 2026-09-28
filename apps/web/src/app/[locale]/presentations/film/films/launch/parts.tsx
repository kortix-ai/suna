'use client';

import { AppleCursor } from '@/features/icon/icons/apple-cursor';
import { cn } from '@/lib/utils';
import type { CSSProperties, ReactNode } from 'react';
import { ease, interp, rise, stagger } from '../../engine/time';

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
          {word}{' '}
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
      {rest ? (
        <Words text={rest} f={f} at={at + 6} offset={n} className="text-muted-foreground" />
      ) : null}
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
      className={cn(
        'bg-popover border-border overflow-hidden rounded-2xl border shadow-2xl',
        className,
      )}
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

/* ── Screen: a real product capture with a camera ───────────────────────── */

/** Screenshot coordinates are CSS px of the 1440 × 900 capture. */
type Rect = readonly [x: number, y: number, w: number, h: number];
type Key = { at: number; focus: Rect; zoom: number };

const SHOT_W = 1440;
const SHOT_H = 900;

function view(k: Key, w: number, h: number) {
  const s = (w / SHOT_W) * k.zoom;
  const [x, y, fw, fh] = k.focus;
  const tx = Math.min(0, Math.max(w - SHOT_W * s, w / 2 - (x + fw / 2) * s));
  const ty = Math.min(0, Math.max(h - SHOT_H * s, h / 2 - (y + fh / 2) * s));
  return { s, tx, ty };
}

/**
 * A capture of the real product, framed like a window. The camera eases
 * between keyframes (`inOutCubic`, zoom about a focus rect, never past the
 * image edge); `ring` draws the selection outline — `--ring`, the product's
 * own selection color — around the control the line is about.
 */
export function Screen({
  src,
  f,
  keys,
  ring,
  width = 1040,
  className,
  style,
  over,
}: {
  src: string;
  f: number;
  keys: readonly Key[];
  ring?: { at: number; rect: Rect };
  width?: number;
  className?: string;
  style?: CSSProperties;
  /** A second capture cross-faded in at `at` (a state change on the same screen). */
  over?: { src: string; at: number };
}) {
  const w = width;
  const h = Math.round((width * SHOT_H) / SHOT_W);
  let i = 0;
  while (i < keys.length - 1 && f >= keys[i + 1].at) i++;
  const a = view(keys[i], w, h);
  const next = keys[i + 1];
  const b = next ? view(next, w, h) : a;
  const t = next ? interp(f, next.at - 36, next.at, 0, 1, ease.inOutCubic) : 0;
  const s = a.s + (b.s - a.s) * t;
  const tx = a.tx + (b.tx - a.tx) * t;
  const ty = a.ty + (b.ty - a.ty) * t;
  const mix = over ? interp(f, over.at, over.at + 12, 0, 1, ease.outQuad) : 0;

  return (
    <div
      className={cn(
        'border-border bg-background relative overflow-hidden rounded-2xl border shadow-2xl',
        className,
      )}
      style={{ width: w, height: h, ...style }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: SHOT_W,
          height: SHOT_H,
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="absolute inset-0 size-full" />
        {over ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={over.src}
            alt=""
            className="absolute inset-0 size-full"
            style={{ opacity: mix, filter: `blur(${(1 - mix) * 4 * (mix > 0 ? 1 : 0)}px)` }}
          />
        ) : null}
        {ring ? (
          <div
            className="border-ring absolute rounded-md border-2"
            style={{
              left: ring.rect[0] - 6,
              top: ring.rect[1] - 6,
              width: ring.rect[2] + 12,
              height: ring.rect[3] + 12,
              opacity: interp(f, ring.at, ring.at + 10, 0, 1, ease.outQuad),
              transform: `scale(${interp(f, ring.at, ring.at + 24, 1.06, 1)})`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
