'use client';

import {
  CubeIcon,
  FileTextIcon,
  GitBranchIcon,
  RocketLaunchIcon,
  ShuffleIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { useDevelopersCopy } from './use-developers-copy';
import { SECTION_HEADING } from './shared';

const ICONS = {
  terminal: TerminalWindowIcon,
  file: FileTextIcon,
  ship: RocketLaunchIcon,
  sandbox: CubeIcon,
  branch: GitBranchIcon,
  model: ShuffleIcon,
} as const;

/** Strong ease-out; each cell fades and lifts 12px, staggered 60ms, once. */
const EASE = [0.23, 1, 0.32, 1] as const;

export function DevelopersLoop() {
  const { loop } = useDevelopersCopy();
  const reduce = useReducedMotion();
  return (
    <section id="loop" className="relative w-full">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 md:py-30">
        <h2 className={`${SECTION_HEADING} mx-auto max-w-4xl text-center`}>{loop.headline}</h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-center text-base text-balance sm:mt-6 sm:text-lg">
          {loop.description}
        </p>
        <ul className="mt-10 grid gap-x-12 gap-y-8 sm:mt-16 sm:grid-cols-2 sm:gap-y-14 md:mt-20 lg:grid-cols-3">
          {loop.items.map((item, i) => {
            const Icon = ICONS[item.icon];
            return (
              <m.li
                key={item.title}
                initial={reduce ? false : { opacity: 0, transform: 'translateY(12px)' }}
                whileInView={{ opacity: 1, transform: 'translateY(0px)' }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.5, delay: i * 0.06, ease: EASE }}
              >
                <Icon className="text-muted-foreground size-5 sm:size-6" aria-hidden />
                <h3 className="text-foreground mt-3 text-lg font-medium sm:mt-8 sm:text-xl md:text-2xl">
                  {item.title}
                </h3>
                <p className="text-muted-foreground mt-1.5 max-w-sm text-pretty sm:mt-4">{item.body}</p>
              </m.li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
