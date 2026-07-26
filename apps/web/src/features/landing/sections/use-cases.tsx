'use client';

import { useCases } from '@/features/landing/content';
import { SectionHeader } from '@/features/landing/section-header';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

/**
 * Use cases grouped by team — the "Expand what every team can do" beat.
 *
 * A tab per team, three concrete jobs each, written the way someone in that
 * team would actually ask. Replaced a scrolling marquee of prompt cards that
 * was busy to read and said roughly the same thing eight times over.
 */
export function LandingUseCases() {
  const [activeId, setActiveId] = useState<string>(useCases.teams[0].id);
  const active = useCases.teams.find((t) => t.id === activeId) ?? useCases.teams[0];

  return (
    <section className="border-border border-t px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeader eyebrow={useCases.eyebrow} title={useCases.title} intro={useCases.intro} />

        <div
          className="mt-12 flex flex-wrap gap-1.5"
          role="tablist"
          aria-label="Teams using Kortix"
        >
          {useCases.teams.map((team) => {
            const selected = team.id === activeId;
            return (
              <button
                key={team.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`usecase-${team.id}`}
                id={`usecase-tab-${team.id}`}
                onClick={() => setActiveId(team.id)}
                className={cn(
                  'cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition-colors',
                  selected
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]',
                )}
              >
                {team.label}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          <motion.ul
            key={active.id}
            id={`usecase-${active.id}`}
            role="tabpanel"
            aria-labelledby={`usecase-tab-${active.id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
            className="mt-8 grid gap-4 md:grid-cols-3"
          >
            {active.items.map((item, i) => (
              <li key={item} className="bg-popover flex flex-col gap-4 rounded-md border px-5 py-5">
                <span className="text-muted-foreground/60 font-mono text-xs">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <p className="text-foreground text-sm leading-relaxed">{item}</p>
              </li>
            ))}
          </motion.ul>
        </AnimatePresence>
      </div>
    </section>
  );
}
