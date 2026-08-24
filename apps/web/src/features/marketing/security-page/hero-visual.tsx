'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { isolation } from './content';

/**
 * `/security` hero scene — the containment.
 *
 * Two lists under two headings would *state* isolation. This shows it: one
 * chamber holding what a session has, and outside it, things arriving on lines
 * that stop dead at its wall.
 *
 * Composition:
 *  - the chamber is solid, elevated, corner-marked, and fills most of the frame;
 *  - what it holds sits inside at full contrast;
 *  - what never gets in is written outside, each on a line that runs *into* the
 *    wall and is stopped by a cross sitting on the wall itself — so the refusal
 *    happens at the boundary rather than being captioned next to it;
 *  - those outside labels are cropped at the left edge, because the list of
 *    things that do not get in is longer than any frame.
 *
 * Both columns are `isolation.inside.items` and `isolation.outside.items`
 * verbatim. This page's gate forbids claiming blanket microVM isolation, which
 * is why the chamber is drawn and never named as a hypervisor.
 *
 * MOTION — one pass on mount, then rest.
 */

const INSIDE = isolation.inside.items;
const OUTSIDE = isolation.outside.items;

/** Where the wall stands. Crosses sit on it; labels run up to it. */
const WALL = 46;

/** Corner ticks — the detail that makes a rectangle read as a chamber. */
const CORNERS = [
  'top-0 left-0 border-t-2 border-l-2 rounded-tl-md',
  'top-0 right-0 border-t-2 border-r-2 rounded-tr-md',
  'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-md',
  'bottom-0 right-0 border-b-2 border-r-2 rounded-br-md',
] as const;

export function SecurityHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label={`A session's chamber: what is ${isolation.inside.label}, and what ${isolation.outside.label}.`}
    >
      <div className="relative h-[24rem] w-full max-w-[38rem] overflow-hidden sm:h-[27rem]">
        {/* ── what never gets in ──────────────────────────────────────── */}
        {OUTSIDE.map((item, i) => (
          <div
            key={item}
            className="absolute left-0 flex items-center gap-2"
            style={{ top: `${13 + i * 20}%`, width: `${WALL}%` }}
          >
            <m.span
              className="text-muted-foreground/40 line-clamp-2 flex-1 pl-1 text-[11px] leading-[1.35]"
              initial={reduceMotion ? false : { opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.38, delay: LEAD + 0.36 + i * 0.07, ease: EASE_OUT }}
            >
              {item}
            </m.span>
            <m.span
              className="bg-border h-px w-5 shrink-0 origin-left"
              initial={reduceMotion ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.3, delay: LEAD + 0.44 + i * 0.07, ease: EASE_OUT }}
              aria-hidden
            />
          </div>
        ))}

        {/* crosses, sitting on the wall itself */}
        {OUTSIDE.map((item, i) => (
          <m.span
            key={`x-${item}`}
            className="bg-background text-muted-foreground/45 absolute z-20 -translate-x-1/2 -translate-y-1/2 px-[3px] font-mono text-[11px] leading-none"
            style={{ top: `${13 + i * 20}%`, left: `${WALL}%` }}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.26, delay: LEAD + 0.52 + i * 0.07, ease: EASE_OUT }}
            aria-hidden
          >
            ✕
          </m.span>
        ))}

        {/* ── the chamber ─────────────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute inset-y-[5%] right-[1%] rounded-xl border p-5"
          style={{ left: `${WALL}%` }}
          {...panel(reduceMotion)}
        >
          {CORNERS.map((corner) => (
            <span
              key={corner}
              className={`border-foreground/25 pointer-events-none absolute size-3.5 ${corner}`}
              aria-hidden
            />
          ))}

          <span className="text-muted-foreground/50 block font-mono text-[10px] tracking-widest uppercase">
            {isolation.inside.label}
          </span>

          <ul className="mt-5 flex flex-col gap-4">
            {INSIDE.map((item, i) => (
              <m.li
                key={item}
                className="flex items-start gap-2.5"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32, delay: LEAD + 0.1 + i * 0.06, ease: EASE_OUT }}
              >
                <span
                  className="bg-foreground mt-[0.42rem] size-1 shrink-0 rounded-full"
                  aria-hidden
                />
                <span className="text-foreground/90 text-[12px] leading-snug text-pretty">
                  {item}
                </span>
              </m.li>
            ))}
          </ul>
        </m.div>

        {/* ── the label for the refused side ──────────────────────────── */}
        <m.span
          className="text-muted-foreground/40 absolute bottom-[4%] left-1 font-mono text-[10px] tracking-widest uppercase"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.68, ease: EASE_OUT }}
          aria-hidden
        >
          {isolation.outside.label}
        </m.span>
      </div>
    </div>
  );
}
