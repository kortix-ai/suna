'use client';

import { Reveal } from '@/components/home/reveal';
import Link from '@/components/site-link';
import SectionHeader from '@/features/marketing/component/section-header';
import { getLocalizedServicesContent } from '@/features/marketing/services/content';
import { getLocalizedStoriesContent, type Story } from '@/features/marketing/stories/content';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { ArrowRightIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * Building blocks shared by the home page, `/product`, `/services` and
 * `/customers`. Each block takes its copy as props or from a content module,
 * so a page is a list of blocks and nothing else.
 */

export const SECTION = 'mx-auto max-w-7xl px-6 py-24 md:py-30';

/* ── stories ──────────────────────────────────────────────────────────────── */

/** The workflow of a story, left to right. Drawn, not screenshotted. */
function Flow({ steps }: { steps: Story['flow'] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1.5">
          {i > 0 ? (
            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
          ) : null}
          <span
            className={cn(
              'border-border rounded-sm border px-2 py-1 font-mono text-xs',
              i === steps.length - 1 ? 'text-foreground bg-secondary' : 'text-muted-foreground',
            )}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StoryCard({ story, large }: { story: Story; large?: boolean }) {
  return (
    <article
      className={cn(
        'border-border bg-card flex h-full flex-col justify-between gap-8 rounded-sm border',
        large ? 'p-8 sm:p-10' : 'p-6 sm:p-8',
      )}
    >
      <div className="flex flex-col gap-4">
        <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {story.eyebrow}
        </span>
        <h3
          className={cn(
            'text-foreground font-medium tracking-tight text-balance',
            large ? 'text-2xl sm:text-3xl' : 'text-xl',
          )}
        >
          {story.title}
        </h3>
        <p className="text-muted-foreground text-base leading-relaxed">{story.body}</p>
      </div>
      <div className="flex flex-col gap-4">
        <Flow steps={story.flow} />
        <p className="text-foreground text-sm font-medium">{story.caption}</p>
      </div>
    </article>
  );
}

/**
 * The stories grid. `limit` shows the first n (the home page shows three);
 * the first card spans two columns so the grid reads as cases, not tiles. The
 * last card spans both too when it would otherwise sit alone in its row.
 */
export function StoriesSection({
  limit,
  showAll = true,
  as,
}: {
  limit?: number;
  showAll?: boolean;
  as?: 'h1' | 'h2';
}): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { stories } = getLocalizedStoriesContent(tI18nComplete);
  const items = limit ? stories.items.slice(0, limit) : stories.items;
  const wide = (i: number) => i === 0 || (items.length % 2 === 0 && i === items.length - 1);
  return (
    <section id="stories" className={SECTION}>
      <SectionHeader eyebrow={stories.eyebrow} title={stories.title} description={stories.sub} as={as} />
      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        {items.map((story, i) => (
          <Reveal key={story.id} delay={0.04 * i} className={cn(wide(i) && 'lg:col-span-2')}>
            <StoryCard story={story} large={i === 0} />
          </Reveal>
        ))}
      </div>
      {showAll ? (
        <Reveal delay={0.1}>
          <Link
            href="/customers"
            className="text-foreground mt-8 inline-flex items-center gap-1.5 text-sm font-medium"
          >
            {stories.cta}
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </Link>
        </Reveal>
      ) : null}
    </section>
  );
}

/* ── the 80/20 goal ───────────────────────────────────────────────────────── */

/** 80% agents, 20% people, drawn to scale. The goal of the service. */
export function GoalBar(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { goal } = getLocalizedServicesContent(tI18nComplete);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-sm">
        <div className="bg-foreground h-full" style={{ width: `${goal.agents.share}%` }} />
        <div className="bg-muted h-full" style={{ width: `${goal.people.share}%` }} />
      </div>
      <div className="flex justify-between font-mono text-xs">
        <span className="text-foreground">
          {goal.agents.share}% {goal.agents.label}
        </span>
        <span className="text-muted-foreground">
          {goal.people.share}% {goal.people.label}
        </span>
      </div>
    </div>
  );
}
