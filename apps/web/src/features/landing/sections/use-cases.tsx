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
            {active.items.map((item) => (
              <li
                key={item.ask}
                className="bg-popover flex flex-col justify-between gap-5 rounded-md border px-5 py-5"
              >
                <p className="text-foreground text-sm leading-relaxed">“{item.ask}”</p>
                {/* The deliverable is the point, so name it rather than imply it. */}
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <ArrowReturn className="size-3.5 shrink-0" />
                  {item.gives}
                </p>
              </li>
            ))}
          </motion.ul>
        </AnimatePresence>
      </div>
    </section>
  );
}

/** Return arrow — "and this is what comes back". */
function ArrowReturn({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 4v3.5a2 2 0 0 1-2 2H4M6.5 7 4 9.5 6.5 12" />
    </svg>
  );
}
