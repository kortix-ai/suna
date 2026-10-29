import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';

import {
  BrainIcon,
  CheckIcon,
  CodeIcon,
  CpuIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  HardDrivesIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

import { localizeMarketingContent as localizeContent } from './content';
import { SovereignHero } from './sovereign-hero';
import { TopicTabs } from './topic-tabs';

/**
 * `/sovereign`: open source, your infrastructure, any model, your files, in
 * the home page's rhythm. Hero with one walkthrough, four pillars, one tab per
 * topic, the no-lock-in band, then the FAQ. Copy and sources: `content.ts`.
 */

type Glyph = ComponentType<{ className?: string }>;

const PILLAR_ICONS: Record<string, Glyph> = {
  code: CodeIcon,
  infra: HardDrivesIcon,
  models: BrainIcon,
  files: FolderSimpleIcon,
};

const LOCK_IN_ICONS: Glyph[] = [CodeIcon, HardDrivesIcon, CpuIcon, GitBranchIcon];

function Pillars() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { pillars } = localizeContent(tMarketing);

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

/** The home page's trust band shape: dark in both themes. */
function LockIn() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { lockIn } = localizeContent(tMarketing);

  return (
    <section id="no-lock-in" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade border-y px-4 lg:px-17">
        <div className="dark bg-muted text-foreground px-6 py-10 lg:px-11 lg:py-16">
          <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
            {lockIn.title}
            <span className="text-muted-foreground block">{lockIn.titleMuted}</span>
          </h2>
          <ul className="bg-border mt-10 grid grid-cols-1 gap-px border sm:grid-cols-2 lg:mt-12 lg:grid-cols-4">
            {lockIn.cells.map(({ k, v }, i) => {
              const Icon = LOCK_IN_ICONS[i];
              return (
                <li key={k} className="bg-muted flex flex-col gap-3 p-5 lg:p-6">
                  <Icon className="size-7" aria-hidden />
                  <h3 className="mt-1 text-base font-medium">{k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{v}</p>
                </li>
              );
            })}
            <li className="bg-muted flex flex-col items-start justify-between gap-6 p-5 sm:col-span-2 sm:flex-row sm:items-center lg:col-span-4 lg:p-6">
              <div>
                <p className="text-base font-medium">{lockIn.isolated}</p>
                <p className="text-muted-foreground mt-1 text-sm">{lockIn.isolatedNote}</p>
              </div>
              <div className="flex flex-wrap gap-2.5">
                <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
                  <Link href="/self-hosted">{tMarketing('text57eb8520e834')}</Link>
                </MarketingButton>
                <MarketingButton size="md" className="hit-area-y-1" asChild>
                  <Link href="/contact">{tMarketing('text1d1d94fb5397')}</Link>
                </MarketingButton>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export function SovereignPage(): ReactNode {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems } = localizeContent(tMarketing);

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
      <SovereignHero />
      <Pillars />
      <TopicTabs />
      <LockIn />
      <FaqSection
        title={tMarketing('text5c7379ce0dce')}
        titleMuted="From the code and the docs."
        items={faqItems}
      />
    </main>
  );
}
