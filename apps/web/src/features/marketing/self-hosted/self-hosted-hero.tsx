'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { useWalkthrough, WalkPanel, WalkTabs } from '@/features/marketing/kit/walkthrough';
import { cn } from '@kortix/ui';

import { localizeMarketingContent as localizeModel } from './model';
import { Terminal, Window } from './parts';

/*
 * The /self-hosted hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band with one terminal. The step
 * strip walks the install (install, configure, start, check) every 4 s until
 * a reader picks a step (never with reduced motion).
 */

const STEP_MS = 4000;

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { steps } = localizeModel(tMarketing);

  const { selected, pick } = useWalkthrough(steps.length, STEP_MS);

  const step = steps[selected];
  const fade = 'animate-in fade-in duration-slower ease-out';

  return (
    <div className="flex w-full flex-col items-center gap-8 lg:gap-10">
      <WalkTabs
        steps={steps}
        idPrefix="selfhost-walk"
        label={tMarketing('textd9aa97698883')}
        selected={selected}
        pick={pick}
      />

      <WalkPanel
        idPrefix="selfhost-walk"
        stepId={step.id}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        {/* A fixed height keeps the band still while the steps change. */}
        <div key={step.id} className={cn('flex min-h-80 flex-col', fade)}>
          <Window title={step.title}>
            <Terminal lines={step.lines} className="px-4 py-4 sm:px-6" />
          </Window>
        </div>
        <p
          key={`line-${step.id}`}
          className={cn('text-foreground px-4 text-center text-base text-balance', fade)}
        >
          {step.line}
        </p>
      </WalkPanel>
    </div>
  );
}

export function SelfHostedHero() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = localizeModel(tMarketing);

  return (
    <section id="hero" className="relative">
      <div className="relative flex flex-col gap-7.5 px-8 pt-32 pb-18 lg:px-28 lg:pt-40">
        <div className="flex flex-col gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            {hero.sub}
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5 pt-2">
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href={hero.why.href}>{hero.why.label}</Link>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href={hero.guide.href}>{hero.guide.label}</Link>
          </MarketingButton>
        </div>
      </div>

      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="bg-card flex flex-col items-center gap-7 px-4 py-8 lg:gap-10 lg:px-11 lg:pt-17 lg:pb-10">
          <Walkthrough />
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            {hero.caption} <span className="text-muted-foreground">{hero.captionMuted}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
