'use client';

import { Reveal } from '@/components/home/reveal';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { marketingButtonVariants } from '@/components/ui/marketing/button';
import { PageHero } from '@/features/marketing/component/page-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { PillLink } from '@/features/marketing/os/primitives';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { useState, type ReactNode } from 'react';
import { ApplyModal } from './apply-modal';
import { getLocalizedCareersContent } from './content';

/* Prose sits on a ~65–70 character measure. The grid is 6xl; body copy never
   runs its full width. */
const MEASURE = 'max-w-[34rem]';

/**
 * The board. One accordion row per opening: collapsed shows the name, the two
 * locations and a single summary line; expanded adds the bullets. Nothing here
 * is a job description — the detail belongs in a conversation.
 */
function Board({ onApply }: { onApply: () => void }): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { LOCATIONS, apply, openings } = getLocalizedCareersContent(tI18nComplete);
  return (
    <section id="openings" className="mx-auto max-w-7xl px-6 pb-4 sm:pb-8">
      <Reveal>
        <Accordion type="single" collapsible className="border-border border-t">
          {openings.map((opening) => (
            <AccordionItem
              key={opening.id}
              value={opening.id}
              className="border-border border-b last:border-b-0"
            >
              <AccordionTrigger className="items-center gap-6 py-6 hover:no-underline sm:py-7">
                <div className="grid w-full gap-1.5 lg:grid-cols-12 lg:items-baseline lg:gap-10">
                  <h3 className="text-foreground text-xl font-normal tracking-tight lg:col-span-4">
                    {opening.name}
                  </h3>
                  <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase lg:col-span-3">
                    {LOCATIONS}
                  </p>
                  <p className="text-muted-foreground text-sm leading-relaxed font-normal lg:col-span-5">
                    {opening.summary}
                  </p>
                </div>
              </AccordionTrigger>

              <AccordionContent className="pb-8">
                <div className="lg:grid lg:grid-cols-12 lg:gap-10">
                  <div className="lg:col-span-8 lg:col-start-5">
                    <ul className={cn(MEASURE, 'space-y-2.5')}>
                      {opening.bullets.map((bullet) => (
                        <li
                          key={bullet}
                          className="text-muted-foreground flex gap-3 text-sm leading-relaxed"
                        >
                          <span aria-hidden className="text-muted-foreground/40 select-none">
                            —
                          </span>
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>

                    {'note' in opening ? (
                      <p className="text-muted-foreground/70 mt-5 max-w-[34rem] text-xs leading-relaxed">
                        {opening.note}
                      </p>
                    ) : null}

                    <button
                      type="button"
                      onClick={onApply}
                      className={cn(
                        marketingButtonVariants({ variant: 'default' }),
                        'mt-6 h-11 rounded-full px-5 text-base',
                      )}
                    >
                      {apply.cta}
                    </button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  );
}

/** The bar. The one prose block on the page that earns its space. */
function Bar(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { bar } = getLocalizedCareersContent(tI18nComplete);
  return (
    <section id="what-we-look-for" className="mx-auto max-w-7xl px-6 py-24 sm:py-30">
      <SectionHeader eyebrow={bar.eyebrow} title={bar.title} description={bar.lead} />
      <Reveal>
        <ul className="border-border mt-12 border-b">
          {bar.items.map((item) => (
            <li
              key={item.id}
              className="border-border grid gap-2 border-t py-5 lg:grid-cols-12 lg:items-baseline lg:gap-10"
            >
              <h3 className="text-foreground text-base font-medium tracking-tight lg:col-span-4">
                {item.title}
              </h3>
              <p className="text-muted-foreground text-base leading-relaxed lg:col-span-8">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

function Apply({ onApply }: { onApply: () => void }): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { apply } = getLocalizedCareersContent(tI18nComplete);
  return (
    <section id="apply" className="mx-auto max-w-7xl px-6 pb-16 sm:pb-24">
      <div className="border-border border-t pt-12 sm:pt-16">
        <SectionHeader eyebrow={apply.eyebrow} title={apply.title} description={apply.body} />
        <Reveal>
          <button
            type="button"
            onClick={onApply}
            className={cn(
              marketingButtonVariants({ variant: 'default' }),
              'mt-8 h-11 rounded-full px-5 text-base',
            )}
          >
            {apply.cta}
          </button>

          <p className="text-muted-foreground mt-10 font-mono text-xs tracking-widest uppercase">
            {apply.directLead}
          </p>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {apply.links.map((link) => (
              <li key={link.id}>
                <a
                  href={link.href}
                  {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  className="text-foreground text-sm underline decoration-current/30 underline-offset-4 transition-colors hover:decoration-current"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * `/careers` — a board, not an essay.
 *
 * Three things only: the openings, the bar, and how to apply. Applications go
 * through `ApplyModal` into the same lead pipeline as "Book your demo". The
 * accuracy gate — locations, no invented comp, the OpenCode distinction — lives
 * in `content.ts`.
 */
export function CareersPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = getLocalizedCareersContent(tI18nComplete);
  const [applyOpen, setApplyOpen] = useState(false);
  const openApply = () => setApplyOpen(true);

  return (
    <main className="bg-background min-h-screen">
      <PageHero
        eyebrow={hero.eyebrow}
        title={hero.title}
        sub={hero.lead}
        actions={
          <>
            <button
              type="button"
              onClick={openApply}
              className={cn(
                marketingButtonVariants({ variant: 'default' }),
                'h-11 rounded-full px-5 text-base',
              )}
            >
              {hero.ctaPrimary}
            </button>
            <PillLink tone="outline" href={hero.ctaSecondaryHref}>
              {hero.ctaSecondary}
            </PillLink>
          </>
        }
      />
      <div className="pt-16" />

      <Board onApply={openApply} />
      <Bar />
      <Apply onApply={openApply} />

      <ApplyModal open={applyOpen} onOpenChange={setApplyOpen} />
    </main>
  );
}
