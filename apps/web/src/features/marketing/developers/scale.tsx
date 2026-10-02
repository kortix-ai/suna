'use client';

import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import { scale } from './content';
import { SECTION_HEADING } from './shared';

const W = 1280;
const H = 340;
const MAIN_Y = 290;
const STAGGER = 0.09;
const DRAW = 0.6;

/** Fork x, merge x, lane y, path. Label sits above the flat segment, left-aligned so it never covers a curve. */
const LANES = [
  {
    fork: 120,
    merge: 700,
    y: 70,
    left: 276,
    d: 'M120 290 C 180 290, 180 70, 260 70 H 560 C 640 70, 640 290, 700 290',
  },
  {
    fork: 200,
    merge: 880,
    y: 140,
    left: 336,
    d: 'M200 290 C 250 290, 250 140, 320 140 H 760 C 830 140, 830 290, 880 290',
  },
  {
    fork: 300,
    merge: 1090,
    y: 210,
    left: 436,
    d: 'M300 290 C 350 290, 350 210, 420 210 H 980 C 1040 210, 1040 290, 1090 290',
  },
] as const;

const pct = (n: number, of: number) => `${(n / of) * 100}%`;

export function DevelopersScale() {
  const reduce = useReducedMotion();
  const inView = { once: true, amount: 'some' } as const;
  const summary = `${scale.mainLabel}: ${scale.branches
    .map((b) => `session ${b.id} ${b.task}`)
    .join(', ')}. ${scale.mergeLabel}.`;

  return (
    <section id="scale" className="relative w-full overflow-clip">
      <div className="relative mx-auto max-w-7xl px-6 py-24 md:py-30">
        <div className="grid gap-6 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-8">
            <h2 className={SECTION_HEADING}>{scale.headline}</h2>
          </div>
          <p className="text-muted-foreground max-w-sm text-lg text-pretty lg:col-span-4">
            {scale.description}
          </p>
        </div>

        <div
          role="region"
          aria-label={scale.graphLabel}
          tabIndex={0}
          className="focus-visible:ring-ring mt-16 overflow-x-auto focus-visible:ring-2 focus-visible:outline-none md:mt-24"
        >
          <div className="min-w-5xl">
            <div role="img" aria-label={summary} className="relative">
              <svg viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden className="block w-full">
                {/* userSpaceOnUse: a horizontal line has a zero-height bbox, so objectBoundingBox renders nothing. */}
                <defs>
                  <linearGradient id="scale-main-fade" gradientUnits="userSpaceOnUse" x1="0" x2={W} y1="0" y2="0">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                    <stop offset="0.04" stopColor="currentColor" />
                    <stop offset="0.96" stopColor="currentColor" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line
                  x1="0"
                  x2={W}
                  y1={MAIN_Y}
                  y2={MAIN_Y}
                  stroke="url(#scale-main-fade)"
                  strokeWidth="1.5"
                  className="text-foreground"
                />
                {LANES.map((lane, i) => {
                  const accent = i === 0;
                  const delay = i * STAGGER;
                  return (
                    <g
                      key={lane.d}
                      className={accent ? 'text-kortix-base' : 'text-muted-foreground'}
                    >
                      <m.path
                        d={lane.d}
                        stroke="currentColor"
                        strokeWidth="1.5"
                        initial={reduce ? false : { pathLength: 0 }}
                        whileInView={{ pathLength: 1 }}
                        viewport={inView}
                        transition={{ duration: DRAW, delay, ease: 'easeOut' }}
                      />
                      <circle
                        cx={lane.fork}
                        cy={MAIN_Y}
                        r="5"
                        fill="currentColor"
                        className={accent ? undefined : 'text-foreground'}
                      />
                      <m.circle
                        cx={lane.merge}
                        cy={MAIN_Y}
                        r="5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className={cn('fill-background', !accent && 'text-foreground')}
                        initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={inView}
                        transition={{ duration: 0.12, delay: DRAW + delay, ease: 'easeOut' }}
                        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                      />
                    </g>
                  );
                })}
              </svg>

              {LANES.map((lane, i) => (
                <span
                  key={lane.d}
                  style={{ left: pct(lane.left, W), top: pct(lane.y, H) }}
                  className={cn(
                    'absolute -translate-y-full pb-2 font-mono text-xs whitespace-nowrap',
                    i === 0 ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {scale.branches[i].id} · {scale.branches[i].task}
                </span>
              ))}
            </div>

            <div className="text-muted-foreground flex justify-between font-mono text-xs">
              <span className="text-foreground">{scale.mainLabel}</span>
              <span>{scale.mergeLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
