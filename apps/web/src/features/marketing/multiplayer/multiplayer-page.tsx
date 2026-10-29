import Link from '@/components/site-link';
import { Band, Heading, PageFrame } from '@/features/marketing/kit/page-frame';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';

import {
  ArrowRightIcon,
  BookOpenTextIcon,
  BrowserIcon,
  ChatsCircleIcon,
  CheckIcon,
  DesktopIcon,
  DeviceMobileIcon,
  FolderSimpleIcon,
  HashIcon,
  PlugIcon,
  RobotIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType } from 'react';

import { localizeMarketingContent as localizeModel } from './model';
import { MultiplayerHero } from './multiplayer-hero';
import { TeamTabs } from './team-tabs';

/**
 * `/multiplayer`: the "Multiplayer AI" pillar in the home page's rhythm. Hero
 * with one shared session walked through, four things the team shares, one
 * tab per topic, the places people work from, then the FAQ. The closing call
 * to action comes from the marketing shell.
 *
 * Copy: `./model.ts`, which cites the doc or code behind every line.
 */

type Glyph = ComponentType<{ className?: string }>;

const PILLAR_ICONS: Record<string, Glyph> = {
  agents: RobotIcon,
  skills: BookOpenTextIcon,
  memory: FolderSimpleIcon,
  connectors: PlugIcon,
};

const SURFACE_ICONS: Record<string, Glyph> = {
  web: BrowserIcon,
  desktop: DesktopIcon,
  mobile: DeviceMobileIcon,
  cli: TerminalWindowIcon,
  slack: HashIcon,
  teams: ChatsCircleIcon,
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

function Surfaces() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { surfaces } = localizeModel(tMarketing);

  return (
    <section id="everywhere" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={surfaces.title} titleMuted={surfaces.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
          {surfaces.items.map(({ id, k, v, href }) => {
            const Icon = SURFACE_ICONS[id];
            return (
              <li key={id} className="bg-background flex">
                <Link
                  href={href}
                  className="group hover:bg-card outline-ring duration-normal flex w-full flex-col gap-3 p-6 transition-colors ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 lg:p-8"
                >
                  <Icon className="text-foreground size-6" aria-hidden />
                  <span className="text-foreground mt-1 flex items-center gap-1.5 text-base font-medium">
                    {k}
                    <ArrowRightIcon
                      className="text-muted-foreground group-hover:text-foreground duration-normal size-3.5 transition-colors ease-out"
                      aria-hidden
                    />
                  </span>
                  <span className="text-muted-foreground text-sm text-pretty">{v}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}

export function MultiplayerPage() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems } = localizeModel(tMarketing);

  return (
    <PageFrame>
      <MultiplayerHero />
      <Pillars />
      <TeamTabs />
      <Surfaces />
      <FaqSection
        title={tMarketing('text9ef9267ca343')}
        titleMuted="Answered from the docs."
        items={faqItems}
      />
    </PageFrame>
  );
}
