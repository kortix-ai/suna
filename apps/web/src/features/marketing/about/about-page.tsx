'use client';

import { Reveal } from '@/components/home/reveal';
import SectionHeader from '@/features/marketing/component/section-header';
import { PillLink } from '@/features/marketing/os/primitives';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { getLocalizedAboutContent } from './content';
import { PageHero } from '@/features/marketing/component/page-hero';

/* Prose sits on a ~65–70 character measure. The grid is 6xl; body copy never
   runs its full width. */
const MEASURE = 'max-w-[34rem]';

/** The dark AI OS pane opens the page; the team photograph overlaps its floor. */
function Hero(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = getLocalizedAboutContent(tI18nComplete);
  return (
    <PageHero
      eyebrow={hero.eyebrow}
      title={hero.title}
      sub={hero.lead}
      actions={
        <>
          <PillLink href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</PillLink>
          <PillLink tone="outline" href={hero.ctaSecondaryHref} target="_blank" rel="noreferrer">
            {hero.ctaSecondary}
          </PillLink>
        </>
      }
    >
      <div className="relative aspect-[2/1] w-full max-w-5xl overflow-hidden rounded-xl border lg:aspect-[21/9]">
        <Image
          src="/images/team.webp"
          alt={hero.imageAlt}
          fill
          priority
          className="object-cover object-bottom"
          sizes="(min-width: 1024px) 1024px, 100vw"
        />
      </div>
    </PageHero>
  );
}

/** The three claims. Mono index, headline, one paragraph, a rule between each. */
function Statements(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { statements } = getLocalizedAboutContent(tI18nComplete);
  return (
    <section id="thesis" className="mx-auto max-w-7xl px-6">
      <ol>
        {statements.map((statement) => (
          <li key={statement.id} className="border-border border-t">
            <Reveal>
              <div className="grid gap-6 py-12 sm:py-16 lg:grid-cols-12 lg:gap-16">
                <div className="lg:col-span-6">
                  <span
                    className="text-muted-foreground font-mono text-xs leading-none font-normal uppercase select-none"
                    data-text="true"
                  >
                    {statement.n}
                  </span>
                  <h2 className="text-foreground mt-4 max-w-xl text-2xl leading-tight font-normal tracking-tight text-balance sm:text-3xl">
                    {statement.title}
                  </h2>
                </div>
                <p
                  className={cn(
                    MEASURE,
                    'text-muted-foreground text-base leading-relaxed lg:col-span-6 lg:pt-8',
                  )}
                >
                  {statement.body}
                </p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlatformSection(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { platform } = getLocalizedAboutContent(tI18nComplete);
  return (
    <section id="platform" className="mx-auto max-w-7xl px-6 py-24 sm:py-30">
      <SectionHeader eyebrow={platform.eyebrow} title={platform.title} />
      <Reveal>
        <p className={cn(MEASURE, 'text-muted-foreground mt-5 text-base leading-relaxed')}>
          {platform.sub}
        </p>

        <ul className="border-border mt-12 border-b">
          {platform.items.map((item) => (
            <li
              key={item.id}
              className="border-border grid gap-2 border-t py-6 lg:grid-cols-12 lg:items-baseline lg:gap-10"
            >
              {/* 6/6, the same split the statements above use, so both sections
                  hang their body copy off one vertical axis. */}
              <h3 className="text-foreground text-xl font-normal tracking-tight lg:col-span-6">
                {item.verb}
              </h3>

              <p
                className={cn(
                  MEASURE,
                  'text-muted-foreground text-base leading-relaxed lg:col-span-6',
                )}
              >
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

/**
 * `/about` — why Kortix exists, in the founder's framing.
 *
 * The team opens the page, then the thesis at the largest type on the site.
 * Everything after it is support: three claims, the six-verb platform table,
 * and one close. Copy and the accuracy gate live in `content.ts`.
 */
export function AboutPage(): ReactNode {
  return (
    <main className="bg-background min-h-screen">
      <Hero />
      <Statements />
      <PlatformSection />
    </main>
  );
}
