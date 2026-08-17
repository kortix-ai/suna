'use client';

import { Reveal } from '@/components/home/reveal';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/marketing/button';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ApplyModal } from './apply-modal';
import { LOCATIONS, apply, bar, hero, openings } from './content';

/* Prose sits on a ~65–70 character measure. The grid is 6xl; body copy never
   runs its full width. */
const MEASURE = 'max-w-[34rem]';

function Eyebrow({ children }: { children: string }): ReactNode {
  return (
    <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
      {children}
    </p>
  );
}

/**
 * The board. One accordion row per opening: collapsed shows the name, the two
 * locations and a single summary line; expanded adds the bullets. Nothing here
 * is a job description — the detail belongs in a conversation.
 */
function Board({ onApply }: { onApply: () => void }): ReactNode {
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
                  <h3 className="text-foreground text-xl font-medium tracking-tight lg:col-span-4">
                    {opening.name}
                  </h3>
                  <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase lg:col-span-3">
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

                    <Button size="sm" className="mt-6" onClick={onApply}>
                      {apply.cta}
                    </Button>
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
  return (
    <section id="what-we-look-for" className="mx-auto max-w-7xl px-6 py-24 sm:py-30">
      <SectionHeader eyebrow={bar.eyebrow} title={bar.title} />
      <Reveal>
        <p className={cn(MEASURE, 'text-muted-foreground mt-5 text-base leading-relaxed')}>
          {bar.lead}
        </p>

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
  return (
    <section id="apply" className="mx-auto max-w-7xl px-6 pb-16 sm:pb-24">
      <div className="border-border border-t pt-12 sm:pt-16">
        <SectionHeader eyebrow={apply.eyebrow} title={apply.title} />
        <Reveal>
          <p className={cn(MEASURE, 'text-muted-foreground mt-5 text-base leading-relaxed')}>
            {apply.body}
          </p>

          <Button size="sm" className="mt-8" onClick={onApply}>
            {apply.cta}
          </Button>

          <p className="text-muted-foreground mt-10 font-mono text-[10px] tracking-widest uppercase">
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
  const [applyOpen, setApplyOpen] = useState(false);
  const openApply = () => setApplyOpen(true);

  return (
    <main className="bg-background min-h-screen">
      <section className="mx-auto max-w-7xl px-6 pt-32 pb-12 sm:pt-44 sm:pb-16">
        <Reveal>
          <Eyebrow>{hero.eyebrow}</Eyebrow>

          <h1 className="text-foreground mt-8 text-4xl leading-[1.02] font-medium tracking-tight sm:text-6xl">
            {hero.title}
          </h1>

          <p className="text-muted-foreground mt-6 text-lg">{hero.lead}</p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={openApply}>
              {hero.ctaPrimary}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      <Board onApply={openApply} />
      <Bar />
      <Apply onApply={openApply} />

      <ApplyModal open={applyOpen} onOpenChange={setApplyOpen} />
    </main>
  );
}
