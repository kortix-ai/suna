'use client';

import { EASE_OUT, LEAD } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { ROLES } from './registry';

/**
 * `/solutions` hub hero scene — the eight, as an index.
 *
 * The hub's subject is the eight teams, so the scene lists them rather than
 * repeating the platform facts the role pages already carry. Each role page
 * shows its own specimen artifact instead (`role-hero-visual.tsx`), which is
 * what stops these nine pages reading as one template.
 *
 * Composition:
 *  - the names are set large and run past the top and bottom edges, masked
 *    there — the list is a column you are looking at part of;
 *  - each line is inset a little further than the last, so the column leans;
 *  - the artifact each role returns is set beside its name in mono, which is
 *    the hub's actual promise: same platform, eight different objects back.
 *
 * MOTION — one pass on mount, then rest.
 */

/** What each role gets back, from that role's own specimen. */
const RETURNS: Record<string, string> = {
  diff: 'a patch',
  table: 'a table',
  doc: 'a document',
  code: 'a query',
};

export function SolutionsHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="The eight teams this platform serves, and the object each one gets back."
    >
      <div className="relative h-[24rem] w-full max-w-[38rem] overflow-hidden sm:h-[27rem]">
        {/* the hairline the column hangs off, bleeding both ends */}
        <m.span
          className="bg-border absolute inset-y-0 left-[3%] w-px mask-y-from-82% mask-y-to-100%"
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.06, ease: EASE_OUT }}
          aria-hidden
        />

        <ul className="absolute inset-0 flex flex-col justify-center mask-y-from-88% mask-y-to-100%">
          {ROLES.map((role, i) => (
            <m.li
              key={role.slug}
              className="flex items-baseline gap-4 py-[0.42rem]"
              style={{ paddingLeft: `${6 + i * 1.6}%` }}
              initial={reduceMotion ? false : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: LEAD + i * 0.055, ease: EASE_OUT }}
            >
              <span className="text-foreground text-[22px] leading-none font-medium tracking-tight sm:text-[26px]">
                {role.name}
              </span>
              <span className="bg-border/70 hidden h-px flex-1 sm:block" />
              <span className="text-muted-foreground/45 shrink-0 font-mono text-[10.5px] whitespace-nowrap">
                {RETURNS[role.output.artifact.kind]}
              </span>
            </m.li>
          ))}
        </ul>
      </div>
    </div>
  );
}
