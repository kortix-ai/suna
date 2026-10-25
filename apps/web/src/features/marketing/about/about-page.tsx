'use client';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER, Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import Link from '@/components/site-link';
import type { ReactNode } from 'react';
import { getLocalizedAboutContent } from './content';

/**
 * `/about` — why Kortix exists, in the founder's framing (Buio team page).
 *
 * Header, then the team photograph, then three sections with one rhythm: the
 * beliefs and the six-verb platform as hairline rows on the shared 4-column
 * grid (title in columns 1–2, text in 3–4), and the hiring call. Copy and the
 * accuracy gate live in `content.ts`.
 */
export function AboutPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero, beliefs, statements, platform, closing } =
    getLocalizedAboutContent(tI18nComplete);

  return (
    <main className="bg-background pt-16">
      <header className={cn(MARKETING_CONTAINER, 'pt-24 md:pt-30')}>
        <SectionHeading
          as="h1"
          title={hero.title}
          titleMuted={hero.titleMuted}
          description={hero.lead}
          actions={
            <>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
                <a href={hero.ctaSecondaryHref} target="_blank" rel="noreferrer">
                  {hero.ctaSecondary}
                </a>
              </MarketingButton>
            </>
          }
        />
        {/* `/images/team.webp` is 1920×1080 with about a quarter of its height
            empty above the heads. `object-bottom` takes the whole crop off the
            top, so the six people stay whole at 2:1 and 21:9. */}
        <div className="bg-muted relative mt-16 aspect-2/1 w-full overflow-hidden lg:aspect-21/9">
          <Image
            src="/images/team.webp"
            alt={hero.imageAlt}
            fill
            priority
            className="object-cover object-bottom"
            sizes="(min-width: 1280px) 1280px, 100vw"
          />
        </div>
      </header>

      <Section id="thesis">
        <SectionHeading title={beliefs.title} titleMuted={beliefs.titleMuted} />
        <ul className="mt-16 border-b">
          {statements.map((statement) => (
            <li
              key={statement.id}
              className="grid grid-cols-1 gap-y-4 border-t py-8 lg:grid-cols-4 lg:py-12"
            >
              <h3 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:col-span-2 lg:pr-8">
                {statement.title}
              </h3>
              <p className="text-muted-foreground max-w-xl text-base text-pretty lg:col-span-2">
                {statement.body}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="platform">
        <SectionHeading
          title={platform.title}
          titleMuted={platform.titleMuted}
          description={platform.sub}
        />
        <ul className="mt-16 border-b">
          {platform.items.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-1 gap-y-2 border-t py-6 lg:grid-cols-4 lg:items-baseline"
            >
              <h3 className="text-foreground text-base font-medium lg:col-span-2 lg:pr-8">
                {item.verb}
              </h3>
              <p className="text-muted-foreground max-w-xl text-sm text-pretty lg:col-span-2">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="hiring">
        <SectionHeading
          title={closing.title}
          titleMuted={closing.titleMuted}
          actions={
            <>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
                <a href={closing.ctaSecondaryHref} target="_blank" rel="noreferrer">
                  {closing.ctaSecondary}
                </a>
              </MarketingButton>
            </>
          }
        />
      </Section>
    </main>
  );
}
