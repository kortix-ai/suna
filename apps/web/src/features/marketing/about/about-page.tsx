'use client';

import Link from '@/components/site-link';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import {
  Band,
  Block,
  CellGrid,
  Heading,
  PageFrame,
  PageHero,
} from '@/features/marketing/kit/page-frame';
import { useTranslations } from '@/i18n/use-translations';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { getLocalizedAboutContent } from './content';

/**
 * `/about`: why Kortix exists, in the founder's framing.
 *
 * Layout: the landing page's frame (`kit/page-frame.tsx`), the same as
 * /security, /self-hosted and /enterprise. The hero, then the team photograph
 * in a band the way the landing hero carries the session window; the two
 * beliefs as three cells; every layer as numbered cells; then where it goes
 * (self-improving companies) and the mission. The hiring call is the footer's
 * call to action (`landing/footer-cta.ts`), so the page does not repeat it.
 * Copy and the accuracy gate live in `content.ts`.
 */
export function AboutPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero, beliefs, statements, platform, future } = getLocalizedAboutContent(tI18nComplete);

  return (
    <PageFrame>
      <section id="hero">
        <PageHero
          title={hero.title}
          titleMuted={hero.titleMuted}
          sub={hero.lead}
          actions={
            <>
              <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
                <a href={hero.ctaSecondaryHref} target="_blank" rel="noreferrer">
                  {hero.ctaSecondary}
                </a>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </MarketingButton>
            </>
          }
        />
        {/* The team, in a plain band like the landing hero's session window.
            `/images/team.webp` is 1920×1080 with about a quarter of its height
            empty above the heads; `object-bottom` crops the top, so the six
            people stay whole at 2:1 and 21:9. */}
        <Band>
          {/* The footer's dither field fills the band around the photo,
              fading in from nothing at the top to full at the bottom. The
              photo sits on top, unchanged. */}
          <div className="bg-card relative isolate px-4 py-7 lg:px-11 lg:py-12">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,transparent,#000)]"
            >
              <DitherField />
            </div>
            <div className="bg-muted relative aspect-2/1 w-full overflow-hidden rounded-md border lg:aspect-21/9">
              <Image
                src="/images/team.webp"
                alt={hero.imageAlt}
                fill
                priority
                className="object-cover object-bottom"
                sizes="(min-width: 1440px) 1300px, 100vw"
              />
            </div>
          </div>
        </Band>
      </section>

      {/* The three beliefs, side by side on hairlines. */}
      <Block id="thesis">
        <Heading title={beliefs.title} titleMuted={beliefs.titleMuted} />
        <Band className="mt-12">
          <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
            {statements.map((statement) => (
              <li key={statement.id} className="bg-background flex flex-col gap-4 p-6 lg:p-11">
                <h3 className="text-foreground text-lg font-medium tracking-tight text-balance">
                  {statement.title}
                </h3>
                <p className="text-muted-foreground max-w-xl text-base text-pretty">
                  {statement.body}
                </p>
              </li>
            ))}
          </ul>
        </Band>
      </Block>

      {/* Every layer, numbered: the shape of the stack, not a checklist.
          The tense in `content.ts` says what ships today; no status marker. */}
      <Block id="platform">
        <Heading title={platform.title} titleMuted={platform.titleMuted} sub={platform.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-3"
            items={platform.items.map((item, i) => ({
              id: item.id,
              n: String(i + 1).padStart(2, '0'),
              k: item.verb,
              v: item.body,
            }))}
          />
        </Band>
      </Block>

      {/* Where it goes: self-improving companies, then the mission. */}
      <FeatureSplit
        id="future"
        title={future.title}
        titleMuted={future.titleMuted}
        body={future.body}
        after={
          <p className="text-foreground px-8 pt-8 text-lg font-medium text-balance lg:px-28">
            {future.mission}
          </p>
        }
      />
    </PageFrame>
  );
}
