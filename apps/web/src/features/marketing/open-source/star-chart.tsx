'use client';

import { useWallpaperTheme } from '@/components/ui/wallpaper-shaders';
import { cn } from '@/lib/utils';
import dynamic from 'next/dynamic';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useHasBeenSeen } from './star-count';

const Shader = dynamic(() => import('@/lib/shaders-react').then((m) => m.Shader), {
  ssr: false,
});
const Dither = dynamic(() => import('@/lib/shaders-react').then((m) => m.Dither), {
  ssr: false,
});
const LinearGradient = dynamic(() => import('@/lib/shaders-react').then((m) => m.LinearGradient), {
  ssr: false,
});

/* Matches the StarCount count-up exactly: same 1600ms, and this bezier is the
   CSS twin of its JS easeOutQuart, so the line's right edge and the digits
   settle together. */
const DURATION_MS = 1600;
const EASE_OUT_QUART = 'cubic-bezier(0.165, 0.84, 0.44, 1)';

const VIEW_W = 100;
const VIEW_H = 32;

/**
 * Stylized growth curve, NOT plotted star history — no dates, no axis, no
 * numbers, so it claims nothing the accuracy gate in `content.ts` forbids.
 * The live count rendered above it is the only figure on this section.
 * Normalized: x 0→100 left to right, y 0 (start) → 1 (today).
 */
const POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [10, 0.02],
  [20, 0.05],
  [30, 0.1],
  [40, 0.18],
  [50, 0.3],
  [58, 0.42],
  [66, 0.52],
  [74, 0.66],
  [82, 0.76],
  [90, 0.88],
  [100, 1],
];

/* 2 viewBox units of headroom so the non-scaling stroke never clips at the
   top; the curve bottoms out on the baseline where the fill closes. */
const Y_TOP = 2;
const toY = (v: number): number => VIEW_H - v * (VIEW_H - Y_TOP);

/**
 * Catmull-Rom → cubic beziers: one smooth pass through every point.
 * `mapX`/`mapY` pick the coordinate space — viewBox units for the visible
 * paths, 0..1 for the objectBoundingBox clip that shapes the dither canvas.
 */
function smoothPath(
  points: ReadonlyArray<readonly [number, number]>,
  mapX: (x: number) => number,
  mapY: (v: number) => number,
): string {
  const p = points.map(([x, y]) => [mapX(x), mapY(y)] as const);
  const f = (n: number): string => Number(n.toFixed(4)).toString();
  let d = `M ${f(p[0]![0])} ${f(p[0]![1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const LINE_PATH = smoothPath(POINTS, (x) => x, toY);
const AREA_PATH = `${LINE_PATH} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`;

/* Same curve in 0..1 coordinates for `clipPathUnits="objectBoundingBox"`:
   the clip stretches with the element exactly like the viewBox does under
   `preserveAspectRatio="none"`, so the dither canvas and the SVG line always
   agree on where the curve is. */
const AREA_CLIP_PATH = `${smoothPath(
  POINTS,
  (x) => x / VIEW_W,
  (v) => toY(v) / VIEW_H,
)} L 1 1 L 0 1 Z`;

/**
 * Decorative backdrop for the open-source section: a faint line chart that
 * wipes in left to right — 0 → today's stars — in sync with the count-up.
 *
 * The fill under the curve is the house Bayer dither (`@/lib/shaders-react`
 * `Dither`, same colors/params as the CTA's `DitherShader`): a vertical
 * luminance ramp quantized to ordered pixels, clipped to the under-curve
 * region. Density is highest at the line and dissolves toward the baseline,
 * so the sparse-left → dense-right texture retells the growth curve. Static —
 * no time uniform, so the canvas costs nothing after first paint.
 *
 * The reveal is a `clip-path: inset()` transition on the wrapper holding both
 * the canvas and the SVG, so line and dither wipe in as one surface on the
 * compositor. It runs once per page load (the `useHasBeenSeen` latch) and is
 * skipped entirely under `prefers-reduced-motion` — the chart is simply
 * there, no movement.
 *
 * Purely decorative: `aria-hidden`, `pointer-events-none`, no data claim.
 */
export function StarChart({ className }: { className?: string }): ReactNode {
  const [ref, seen] = useHasBeenSeen<HTMLDivElement>();
  const [reduced, setReduced] = useState(false);
  const { isDark, bg } = useWallpaperTheme();
  const uid = useId();
  const gradientId = `${uid}-fill`;
  const clipId = `${uid}-clip`;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn('text-foreground pointer-events-none select-none', className)}
    >
      <div
        className="absolute inset-0"
        style={
          reduced
            ? undefined
            : {
                clipPath: seen ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
                transition: `clip-path ${DURATION_MS}ms ${EASE_OUT_QUART}`,
              }
        }
      >
        {/* Dithered fill, clipped to the area under the curve. Params match
            the CTA DitherShader so both landing sections share one texture. */}
        <div
          className="absolute inset-0 opacity-15"
          style={{ clipPath: `url(#${clipId})` }}
        >
          <Shader
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          >
            <Dither
              colorA={bg}
              colorB={isDark ? '#84858d' : '#55565d'}
              colorMode="custom"
              pattern="bayer8"
              pixelSize={6}
              spread={1}
              threshold={0.47}
            >
              {/* Bright at the top of the element, black at the baseline: dot
                  density peaks just under the line and thins band by band on
                  the way down. Caps at ~48% density — never a checkerboard. */}
              <LinearGradient
                colorA="#7c7c7c"
                colorB="#000000"
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
              />
            </Dither>
          </Shader>
        </div>

        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.08" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
            <clipPath id={clipId} clipPathUnits="objectBoundingBox">
              <path d={AREA_CLIP_PATH} />
            </clipPath>
          </defs>

          <path d={AREA_PATH} fill={`url(#${gradientId})`} />
          <path
            d={LINE_PATH}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  );
}
