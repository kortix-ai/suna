import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';

import {
  ArrowDownIcon,
  CheckIcon,
  CodeIcon,
  CpuIcon,
  FileCodeIcon,
  GitBranchIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

import { FrameworkHero } from './framework-hero';
import { FrameworkTabs } from './framework-tabs';
import { localizeMarketingContent as localizeModel } from './model';

/**
 * `/framework` ("Company as code" in the menu): Kortix as a backend
 * framework for agents, in the home page's rhythm. Hero with one walkthrough
 * from kortix.yaml to a running agent, four pillars, one tab per part, the
 * architecture, then the FAQ.
 *
 * Copy: `model.ts`, which cites the code or doc behind every line. Translated through the marketing catalog. `content.ts` holds the Arcadia sample project the home hero
 * also renders.
 */

type Glyph = ComponentType<{ className?: string }>;

const PILLAR_ICONS: Record<string, Glyph> = {
  repo: GitBranchIcon,
  manifest: FileCodeIcon,
  computer: CpuIcon,
  build: CodeIcon,
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

/** One box of the architecture: a name and one sentence. */
function Box({
  k,
  v,
  dashed,
  strong,
  children,
}: {
  k: string;
  v: string;
  dashed?: boolean;
  strong?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'bg-background flex min-w-0 flex-col gap-2 rounded-lg border p-5 lg:p-6',
        dashed && 'border-dashed',
        strong && 'border-foreground',
      )}
    >
      <h3 className="text-foreground text-lg font-medium">{k}</h3>
      <p className="text-muted-foreground text-sm text-pretty">{v}</p>
      {children}
    </div>
  );
}

function Down() {
  return <ArrowDownIcon aria-hidden className="text-muted-foreground mx-auto my-3 size-5" />;
}

function Architecture() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { architecture } = localizeModel(tMarketing);

  const a = architecture;
  return (
    <section id="architecture" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={a.title} titleMuted={a.titleMuted} />
      <Band className="mt-12">
        <div className="bg-card px-4 py-8 lg:px-11 lg:py-14">
          <figure
            aria-label={tMarketing('text5da7f20a76af')}
            className="mx-auto flex max-w-5xl flex-col"
          >
            <Box k={a.clients.k} v={a.clients.v}>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {a.clients.chips.map((chip) => (
                  <li
                    key={chip}
                    className="bg-muted text-foreground rounded-md px-2.5 py-1 text-sm"
                  >
                    {chip}
                  </li>
                ))}
              </ul>
            </Box>
            <Down />
            <Box k={a.api.k} v={a.api.v} strong />
            <Down />
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
              <Box k={a.repo.k} v={a.repo.v} />
              <Box k={a.computer.k} v={a.computer.v} dashed />
              <Box k={a.gateway.k} v={a.gateway.v} />
            </div>
            <Down />
            <Box k={a.drive.k} v={a.drive.v} />
          </figure>
        </div>
      </Band>
    </section>
  );
}

export function FrameworkPage(): ReactNode {
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
      <FrameworkHero />
      <Pillars />
      <FrameworkTabs />
      <Architecture />
      <FaqSection
        title={tMarketing('textac99bcb21f10')}
        titleMuted="Answered from the docs."
        items={faqItems}
      />
    </main>
  );
}
