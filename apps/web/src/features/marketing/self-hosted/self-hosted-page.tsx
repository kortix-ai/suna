import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';

import {
  ArrowsClockwiseIcon,
  CheckIcon,
  IdentificationBadgeIcon,
  StackIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

import { localizeMarketingContent as localizeModel } from './model';
import { SelfHostedHero } from './self-hosted-hero';
import { TopicTabs } from './topic-tabs';

/**
 * `/self-hosted`: how to run Kortix on your own server, in the home page's
 * rhythm. Hero with the real install, four pillars, one tab per topic, then
 * the FAQ. /sovereign covers why; this page covers how. Copy and sources:
 * `model.ts`.
 */

type Glyph = ComponentType<{ className?: string }>;

const PILLAR_ICONS: Record<string, Glyph> = {
  cli: TerminalWindowIcon,
  stack: StackIcon,
  updates: ArrowsClockwiseIcon,
  enterprise: IdentificationBadgeIcon,
};

function Pillars() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { pillars } = localizeModel(tMarketing);

  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={pillars.title} titleMuted={pillars.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          {pillars.items.map(({ id, name, line, facts }) => {
            const Icon = PILLAR_ICONS[id];
            return (
              <li key={id} className="bg-background flex flex-col gap-5 p-6 lg:p-10">
                <Icon className="text-foreground size-6" aria-hidden />
                <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                  {name}
                  <span className="text-muted-foreground mt-1 block text-lg leading-snug">
                    {line}
                  </span>
                </h3>
                <ul className="mt-auto flex flex-col gap-2 text-sm">
                  {facts.map((fact) => (
                    <li key={fact} className="text-foreground flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {fact}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}

export function SelfHostedPage(): ReactNode {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems } = localizeModel(tMarketing);

  return (
    <main className="bg-background relative mx-auto w-full max-w-[1440px]">
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17"
      />
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17"
      />
      <SelfHostedHero />
      <Pillars />
      <TopicTabs />
      <FaqSection
        title={tMarketing('text46bdaae09ca4')}
        titleMuted="From the CLI and the docs."
        items={faqItems}
      />
    </main>
  );
}
