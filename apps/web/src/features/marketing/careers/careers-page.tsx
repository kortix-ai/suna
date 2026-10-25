'use client';

import { Disclosure, DisclosureList } from '@/features/marketing/kit/disclosure';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER, Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import Link from '@/components/site-link';
import { useState, type ReactNode } from 'react';
import { ApplyModal } from './apply-modal';
import { getLocalizedCareersContent } from './content';

type CareersContent = ReturnType<typeof getLocalizedCareersContent>;

/**
 * The board (Buio jobs list). One kit `Disclosure` row per opening: the name
 * in the first of three columns, the summary line in the other two. `name`
 * keeps one open at a time. Open, the bullets and the Apply button sit under
 * the summary column. The name is a span, not a heading: a `summary` may hold
 * one heading alone or phrasing content, not both.
 */
function Board({
  hero,
  openings,
  apply,
  onApply,
}: Pick<CareersContent, 'hero' | 'openings' | 'apply'> & { onApply: () => void }): ReactNode {
  return (
    <section id="openings" className={cn(MARKETING_CONTAINER, 'scroll-mt-16 pt-16')}>
      {/* Column labels on the rows' grid; the empty cell stands in for the row's "+". */}
      <div aria-hidden className="text-muted-foreground hidden gap-6 border-t py-4 text-sm lg:flex">
        <span className="grid flex-1 grid-cols-3">
          <span className="text-foreground pr-8">{hero.roleLabel}</span>
          <span className="col-span-2">{hero.summaryLabel}</span>
        </span>
        <span className="size-4 shrink-0" />
      </div>
      <DisclosureList className="lg:border-t-0">
        {openings.map((opening) => (
          <Disclosure
            key={opening.id}
            name="openings"
            summary={
              <span className="grid grid-cols-1 items-baseline gap-y-2 lg:grid-cols-3">
                <span className="text-xl font-medium tracking-tight text-balance md:text-2xl lg:col-span-1 lg:pr-8">
                  {opening.name}
                </span>
                <span className="text-muted-foreground max-w-xl text-sm text-pretty lg:col-span-2">
                  {opening.summary}
                </span>
              </span>
            }
          >
            <div className="pb-2 lg:grid lg:grid-cols-3 lg:pr-10">
              <div className="max-w-xl lg:col-span-2 lg:col-start-2">
                <ul className="text-muted-foreground marker:text-muted-foreground list-disc space-y-2 pl-4 text-sm text-pretty">
                  {opening.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
                {'note' in opening ? (
                  <p className="text-muted-foreground mt-6 text-sm text-pretty">{opening.note}</p>
                ) : null}
                <MarketingButton size="md" className="hit-area-y-1 mt-8" onClick={onApply}>
                  {apply.cta}
                </MarketingButton>
              </div>
            </div>
          </Disclosure>
        ))}
      </DisclosureList>
    </section>
  );
}

/**
 * `/careers` — a board, not an essay (Buio jobs page).
 *
 * The header, the openings, the bar as a 3-up definition list, and how to
 * apply. Applications go through `ApplyModal` into the same lead pipeline as
 * "Book your demo". The accuracy gate (locations, no invented comp, the
 * OpenCode distinction) lives in `content.ts`.
 */
export function CareersPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero, openings, bar, apply } = getLocalizedCareersContent(tI18nComplete);
  const [applyOpen, setApplyOpen] = useState(false);
  const openApply = () => setApplyOpen(true);

  return (
    <main className="bg-background pt-16">
      <header
        className={cn(MARKETING_CONTAINER, 'grid grid-cols-1 gap-y-8 pt-24 md:pt-30 lg:grid-cols-4 lg:items-end')}
      >
        <SectionHeading
          as="h1"
          title={hero.title}
          titleMuted={hero.lead}
          description={hero.description}
          className="lg:col-span-3"
        />
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
            <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" onClick={openApply}>
            {hero.ctaPrimary}
          </MarketingButton>
        </div>
      </header>

      <Board hero={hero} openings={openings} apply={apply} onApply={openApply} />

      <Section id="what-we-look-for">
        <SectionHeading title={bar.title} titleMuted={bar.titleMuted} description={bar.lead} />
        <dl className="mt-16 grid grid-cols-1 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
          {bar.items.map((item) => (
            <div key={item.id} className="md:pr-8">
              <dt className="text-foreground text-base font-medium text-pretty">{item.title}</dt>
              <dd className="text-muted-foreground mt-2 text-sm text-pretty">{item.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="apply" className="pt-0 md:pt-0">
        <div className="grid grid-cols-1 gap-y-12 border-t pt-8 lg:grid-cols-4">
          <SectionHeading
            title={apply.title}
            titleMuted={apply.titleMuted}
            description={apply.body}
            actions={
              <MarketingButton size="md" className="hit-area-y-1" onClick={openApply}>
                {apply.cta}
              </MarketingButton>
            }
            className="lg:col-span-2 lg:pr-12"
          />
          <div className="lg:col-span-2">
            <p className="text-muted-foreground text-sm">{apply.directLead}</p>
            <ul className="mt-4 border-b">
              {apply.links.map((link) => (
                <li key={link.id} className="border-t">
                  <a
                    href={link.href}
                    {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                    className="text-foreground hover:text-muted-foreground block py-3 text-base transition-colors duration-moderate"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <ApplyModal open={applyOpen} onOpenChange={setApplyOpen} />
    </main>
  );
}
