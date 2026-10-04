'use client';

import Link from '@/components/site-link';
import { KIND_LABEL, RoleArtifactBody } from '@/features/marketing/solutions/role-hero-visual';
import { ROLES } from '@/features/marketing/solutions/registry';
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { workCarousel } from './content';
import { CardArrow, Heading } from './primitives';

/**
 * Square cards that bleed off the right edge. Each card is one role page: its
 * own hero line on top and its own sample artifact underneath, cropped, because
 * the artifact is an excerpt. No customer, no metric.
 */
export function WorkCarousel() {
  const track = useRef<HTMLUListElement>(null);
  const scroll = (dir: 1 | -1) =>
    track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section className="py-24 md:py-30">
      <div className="mx-auto flex w-full max-w-7xl items-end justify-between gap-6 px-6">
        <Heading>{workCarousel.title}</Heading>
        <div className="hidden shrink-0 gap-2 sm:flex">
          {([-1, 1] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              aria-label={dir < 0 ? 'Previous' : 'Next'}
              onClick={() => scroll(dir)}
              className="border-border text-foreground hover:bg-muted flex size-11 items-center justify-center rounded-full border transition-colors"
            >
              {dir < 0 ? <ArrowLeftIcon className="size-4" /> : <ArrowRightIcon className="size-4" />}
            </button>
          ))}
        </div>
      </div>

      <ul
        ref={track}
        className="mt-12 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-6 pb-4 [scrollbar-width:none] xl:px-[max(1.5rem,calc((100vw-80rem)/2+1.5rem))]"
      >
        {ROLES.map((role) => (
          <li key={role.slug} className="shrink-0 snap-start">
            <Link
              href={`/solutions/${role.slug}`}
              className="group bg-card border-border hover:border-foreground/30 flex aspect-square w-[min(80vw,26rem)] flex-col overflow-hidden rounded-xl border transition-colors"
            >
              <div className="flex items-start justify-between gap-4 p-6">
                <div className="space-y-3">
                  <span className="text-muted-foreground font-mono text-xs uppercase">{role.name}</span>
                  <p className="text-foreground text-2xl font-normal tracking-tight text-balance">
                    {role.hero.title}
                  </p>
                </div>
                <CardArrow className="text-muted-foreground group-hover:text-foreground" />
              </div>
              <div className="border-border bg-background mx-6 mt-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-md border border-b-0">
                <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-2">
                  <span className="text-muted-foreground truncate font-mono text-xs">{role.output.artifact.file}</span>
                  <span className="text-muted-foreground/70 font-mono text-xs uppercase">
                    {KIND_LABEL[role.output.artifact.kind]}
                  </span>
                </div>
                <div aria-hidden className="min-h-0 flex-1 overflow-hidden mask-b-from-60% mask-b-to-100%">
                  <RoleArtifactBody artifact={role.output.artifact} />
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
