'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { useWalkthrough, WalkPanel, WalkTabs } from '@/features/marketing/kit/walkthrough';
import { cn } from '@kortix/ui';
import { FolderSimpleIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';

import { localizeMarketingContent as localizeContent, type StepId } from './content';
import { Status, Window } from './parts';

/*
 * The /enterprise hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band with one product window, the
 * company view of the fictional Arcadia. The window stays; what it shows
 * grows with the step: one team, every team on shared Drive memory, agents
 * on schedules and webhooks, then the rules that govern them. It advances
 * every 4 s until a reader picks a step (never with reduced motion).
 */

const STEP_MS = 4000;

/** One card per team. A team not rolled out yet shows as a dashed outline. */
function CompanyView({ step }: { step: StepId }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { driveLine, governedLine, teams } = localizeContent(tMarketing);

  const fade = 'animate-in fade-in duration-slower ease-out';
  return (
    <Window title={tMarketing('textf33f48537342')}>
      <ul className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4">
        {teams.map((t) => {
          const state = t.states[step];
          return (
            <li
              key={t.team}
              className={cn(
                'flex min-h-28 flex-col gap-2 rounded-md border p-4',
                state ? 'bg-background' : 'border-dashed',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground font-mono text-xs tracking-wide uppercase">
                  {t.team}
                </span>
                {state ? (
                  <span key={`${step}-${t.team}`} className={fade}>
                    <Status tone={state.tone}>{state.chip}</Status>
                  </span>
                ) : null}
              </div>
              {state ? (
                <>
                  <code className="text-foreground font-mono text-sm font-medium">{t.agent}</code>
                  <span
                    key={`${step}-${t.team}-line`}
                    className={cn('text-muted-foreground text-sm text-pretty', fade)}
                  >
                    {state.line}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground text-sm">
                  {tMarketing('text054b3c503be1')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {/* The rows below appear as the rollout grows; a fixed slot keeps the window still. */}
      <div className="flex min-h-12 flex-col justify-center border-t px-4 py-3 sm:px-6">
        {step === 'one' ? (
          <span className="text-muted-foreground text-sm">{tMarketing('textc63c5f5bb2bb')}</span>
        ) : step === 'governed' ? (
          <span
            key="governed"
            className={cn('text-foreground flex items-center gap-2 text-sm', fade)}
          >
            <ShieldCheckIcon className="size-4 shrink-0" aria-hidden />
            {governedLine}
          </span>
        ) : (
          <span
            key="drive"
            className={cn('text-foreground flex flex-wrap items-center gap-x-2 text-sm', fade)}
          >
            <FolderSimpleIcon className="size-4 shrink-0" aria-hidden />
            {driveLine.k}
            <span className="text-muted-foreground">· {driveLine.v}</span>
          </span>
        )}
      </div>
    </Window>
  );
}

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { steps } = localizeContent(tMarketing);

  const { selected, pick } = useWalkthrough(steps.length, STEP_MS);

  const step = steps[selected];
  const fade = 'animate-in fade-in duration-slower ease-out';

  return (
    <div className="flex w-full flex-col items-center gap-8 lg:gap-10">
      <WalkTabs
        steps={steps}
        idPrefix="enterprise-walk"
        label={tMarketing('text09583d356624')}
        selected={selected}
        pick={pick}
      />

      <WalkPanel
        idPrefix="enterprise-walk"
        stepId={step.id}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        <CompanyView step={step.id} />
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

export function EnterpriseHero() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = localizeContent(tMarketing);

  const openDemo = useRequestDemo();
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
            <Link href="/pricing">{tMarketing('text30d9abfd7c7a')}</Link>
          </MarketingButton>
          <MarketingButton
            size="md"
            className="hit-area-y-1"
            onClick={() => openDemo({ source: 'enterprise-hero' })}
          >
            {tMarketing('textcfd0b0225710')}
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
