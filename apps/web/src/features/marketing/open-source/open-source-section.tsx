'use client';

import { Reveal } from '@/components/home/reveal';
import { Github } from '@/features/icon/icons/github';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { openSource } from './content';
import { StarChart } from './star-chart';
import { StarCount } from './star-count';

export function OpenSourceSection(): ReactNode {
  return (
    <main className="relative h-full w-full py-14">
      <div className="from-background absolute inset-0 -bottom-3 mt-auto h-30 bg-linear-to-t to-transparent" />

      <StarChart className="absolute inset-0 bottom-0 h-full mask-y-from-70% mask-r-from-95%" />
      <section id="open-source" className="relative mx-auto max-w-7xl px-6 pb-32 sm:pb-48">
        <Reveal className="relative mr-auto flex max-w-xl flex-col items-start">
          <StarCount caption={openSource.stars.caption} />

          <h2 className="text-foreground mt-8 max-w-lg text-lg font-medium tracking-tight text-pretty sm:text-xl">
            {openSource.title}
          </h2>

          <nav className="mt-8 flex flex-wrap items-center gap-x-5">
            <Link
              href={openSource.aboutHref}
              className={cn(
                'duration-fast inline-flex min-h-10 items-center text-sm transition-colors',
                'text-foreground underline decoration-current/25 underline-offset-4 hover:decoration-current',
              )}
            >
              {openSource.aboutLabel}
            </Link>
            <span aria-hidden className="text-muted-foreground/30 font-mono text-[10px]">
              /
            </span>
            <a
              href={openSource.repoHref}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'duration-fast inline-flex min-h-10 items-center gap-1.5 text-sm transition-colors',
                'text-muted-foreground hover:text-foreground',
              )}
            >
              <Github className="size-3.5 shrink-0" />
              {openSource.repoLabel}
            </a>
          </nav>
        </Reveal>
      </section>
    </main>
  );
}
