'use client';

import { EASE_OUT, LEAD } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * `/solutions` hero scene — the index.
 *
 * Unlike the capability heroes this one takes its content as a prop, because
 * the surface is templated: one hub plus a role page per registry entry, each
 * with its own four facts. Eight bespoke scenes would be eight scenes saying
 * the same thing.
 *
 * What keeps it from being another bordered list is typographic scale: the
 * ordinals are set enormous and nearly invisible, the facts sit against them,
 * and each row is inset a little further than the last so the column leans. The
 * first ordinal is cropped by the top edge.
 *
 * MOTION — one pass on mount, then rest.
 */

export function SolutionsHeroVisual({
  specs,
}: {
  specs: readonly { readonly k: string; readonly v: string }[];
}): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div className="flex w-full items-center justify-center">
      <div className="relative h-[23rem] w-full max-w-[38rem] overflow-hidden sm:h-[25rem]">
        {/* One hairline the whole column hangs off, bleeding both ends. */}
        <m.span
          className="bg-border absolute inset-y-0 left-[6%] w-px mask-y-from-80% mask-y-to-100%"
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.06, ease: EASE_OUT }}
          aria-hidden
        />

        <dl className="absolute inset-0 flex flex-col justify-center">
          {specs.map((spec, i) => (
            <m.div
              key={spec.k}
              className="relative flex items-baseline gap-5 py-3.5"
              style={{ paddingLeft: `${8 + i * 3}%` }}
              initial={reduceMotion ? false : { opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: LEAD + i * 0.08, ease: EASE_OUT }}
            >
              {/* the ordinal, set as texture rather than as a label */}
              <span
                className="text-foreground/[0.07] pointer-events-none absolute -top-3 left-[4%] font-mono text-[3.6rem] leading-none font-medium tabular-nums select-none"
                aria-hidden
              >
                {String(i + 1).padStart(2, '0')}
              </span>

              <div className="relative min-w-0">
                <dt className="text-muted-foreground/55 font-mono text-[10px] tracking-widest uppercase">
                  {spec.k}
                </dt>
                <dd className="text-foreground mt-2 text-[15px] leading-snug font-medium text-pretty">
                  {spec.v}
                </dd>
              </div>
            </m.div>
          ))}
        </dl>
      </div>
    </div>
  );
}
