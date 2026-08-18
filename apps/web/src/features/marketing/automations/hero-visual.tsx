'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { schedule, webhook } from './content';

/**
 * `/automations` hero scene — the axis, anchored to a moment.
 *
 * A schedule is a shape in time, so the scene is a time axis. What makes it
 * read as a schedule rather than dots on lines is the *now* line: marks to the
 * left of it have already fired and are dimmed, marks to the right have not,
 * and the callout points at the very next one. That single vertical rule is
 * what gives the whole composition a tense.
 *
 * Composition:
 *  - the axis and every lane run past both edges and are masked there;
 *  - lane labels sit in a fixed gutter, so no label floats on top of its own
 *    line;
 *  - fire-marks fall where each cron actually implies — a weekday trigger marks
 *    often, a monthly one marks once;
 *  - the next run is the only filled mark, and a hairline drops from it into an
 *    elevated callout, so the card is attached to a point rather than parked
 *    near it.
 *
 * Rows are `schedule.rows` verbatim (real 6-field cron, real IANA names — this
 * page rejects abbreviations, so none appear here).
 *
 * MOTION — one pass on mount, then rest.
 */

const ROWS = schedule.rows.slice(0, 3);

/** Fractions of the axis. Shape follows the cron, not the composition. */
const MARKS: readonly (readonly number[])[] = [
  [0.06, 0.22, 0.38, 0.54, 0.7, 0.86], // 0 0 9 * * 1-5  — every weekday
  [0.64], //                              0 30 6 1 * *   — once a month
  [0.28, 0.92], //                        0 0 17 * * 5   — weekly, two in frame
];

/**
 * The present. Everything left of it has already fired.
 *
 * 0.58 is not arbitrary: `daily-digest` marks at 0.54, so a `now` any earlier
 * would leave that run upcoming and make the callout below — which names
 * `invoice-sweep` at 0.64 as the next run — plainly wrong to anyone reading
 * the marks.
 */
const NOW = 0.58;
/** The next run after `NOW` — the monthly sweep, and what the callout names. */
const NEXT = { lane: 1, at: 0.64 };

const GUTTER = '6.5rem';

export function AutomationsHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;
  const next = ROWS[NEXT.lane];

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="Three scheduled triggers on a time axis with a present-moment marker, and the next run called out."
    >
      <div className="relative h-[23rem] w-full max-w-[38rem] overflow-hidden sm:h-[25rem]">
        {/* ── the present ─────────────────────────────────────────────── */}
        <m.span
          className="border-foreground/25 absolute top-[10%] bottom-[42%] border-l border-dashed"
          style={{ left: `calc(${GUTTER} + (100% - ${GUTTER}) * ${NOW})` }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.42, delay: LEAD + 0.16, ease: EASE_OUT }}
          aria-hidden
        />
        <m.span
          className="text-muted-foreground/45 absolute top-[6%] font-mono text-[10px] tracking-widest uppercase"
          style={{ left: `calc(${GUTTER} + (100% - ${GUTTER}) * ${NOW} + 0.5rem)` }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.34, ease: EASE_OUT }}
          aria-hidden
        >
          now
        </m.span>

        {/* ── the axis ────────────────────────────────────────────────── */}
        <div
          className="absolute top-[17%] right-0 mask-x-from-84% mask-x-to-100%"
          style={{ left: GUTTER }}
          aria-hidden
        >
          <m.span
            className="bg-border absolute inset-x-0 top-0 block h-px origin-left"
            initial={reduceMotion ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.6, delay: 0.06, ease: EASE_OUT }}
          />
          {Array.from({ length: 13 }, (_, i) => (
            <m.span
              key={i}
              className="bg-border absolute top-0 h-1.5 w-px"
              style={{ left: `${(i / 12) * 100}%` }}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.22, delay: 0.14 + i * 0.012, ease: EASE_OUT }}
            />
          ))}
        </div>

        {/* ── the lanes ───────────────────────────────────────────────── */}
        {ROWS.map((row, lane) => (
          <div
            key={row.slug}
            className="absolute inset-x-0 flex items-center"
            style={{ top: `${27 + lane * 11}%` }}
          >
            <m.span
              className="text-muted-foreground/55 shrink-0 pr-3 text-right font-mono text-[11px]"
              style={{ width: GUTTER }}
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.32, delay: LEAD + lane * 0.06, ease: EASE_OUT }}
            >
              {row.slug}
            </m.span>

            <span className="relative h-3 flex-1">
              <m.span
                className="bg-border/70 absolute inset-x-0 top-1/2 block h-px origin-left mask-x-from-84% mask-x-to-100%"
                initial={reduceMotion ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.5, delay: LEAD + 0.04 + lane * 0.06, ease: EASE_OUT }}
                aria-hidden
              />
              {(MARKS[lane] ?? []).map((at, i) => {
                const isNext = lane === NEXT.lane && at === NEXT.at;
                const fired = at < NOW;
                return (
                  <m.span
                    key={at}
                    className={cn(
                      'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                      isNext
                        ? 'bg-foreground ring-card size-2.5 ring-4'
                        : fired
                          ? 'bg-muted-foreground/20 size-1.5'
                          : 'border-muted-foreground/45 size-1.5 border bg-transparent',
                    )}
                    style={{ left: `${at * 100}%` }}
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      duration: 0.28,
                      delay: LEAD + 0.2 + lane * 0.05 + i * 0.03,
                      ease: EASE_OUT,
                    }}
                    aria-hidden
                  />
                );
              })}
            </span>
          </div>
        ))}

        {/* ── the hairline tying the next run to its card ─────────────── */}
        <m.span
          className="border-border absolute border-l border-dashed"
          style={{
            left: `calc(${GUTTER} + (100% - ${GUTTER}) * ${NEXT.at})`,
            top: `${27 + NEXT.lane * 11 + 1}%`,
            height: '17%',
          }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.44, ease: EASE_OUT }}
          aria-hidden
        />

        {/* ── what happens next ───────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute right-[3%] bottom-[5%] left-[22%] rounded-lg border p-4 "
          {...panel(reduceMotion)}
        >
          <span className="text-muted-foreground/45 block font-mono text-[10px] tracking-widest uppercase">
            next run
          </span>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-foreground font-mono text-[14px]">{next?.slug}</span>
            <span className="text-muted-foreground/45 font-mono text-[11px]">{next?.tz}</span>
          </div>
          <p className="text-foreground/85 mt-2 text-[13px] leading-snug">{next?.reads}</p>
          <p className="border-border/50 text-muted-foreground/45 mt-3 truncate border-t pt-2.5 font-mono text-[11px] tabular-nums">
            {next?.cron}
          </p>
        </m.div>

        {/* ── the other way in, kept quiet in the corner ──────────────── */}
        <m.span
          className="text-muted-foreground/35 absolute bottom-[1%] left-0 truncate font-mono text-[10px]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.7, ease: EASE_OUT }}
          aria-hidden
        >
          {webhook.header}
        </m.span>
      </div>
    </div>
  );
}
