'use client';

import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { Reveal } from '@/components/home/reveal';

/* ─── Small horizontal rule divider ─── */
function Divider() {
  return <div className="w-8 h-px bg-foreground/10 my-12" />;
}

/* ─── Numbered doctrine item ─── */
function DoctrineItem({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <Reveal>
      <div className="flex gap-5">
        <span className="text-xs font-mono text-muted-foreground pt-0.5 shrink-0 w-6 text-right">
          {number}
        </span>
        <div>
          <p className="text-sm font-medium text-foreground mb-1">{title}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        </div>
      </div>
    </Reveal>
  );
}

/* ─── Inline stat chip ─── */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground">
        {value}
      </span>
      <span className="text-xs text-muted-foreground leading-snug">{label}</span>
    </div>
  );
}

export default function FactoryPageClient() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-3xl mx-auto px-6 pt-28 sm:pt-36 pb-28 sm:pb-36">

        {/* ── Opening thesis ── */}
        <Reveal>
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-6">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line56JsxTextTheAutonomyFactory')}</p>
        </Reveal>

        <Reveal delay={0.05}>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-[1.1] mb-8">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line62JsxTextWeBuild')}<br />{tHardcodedUi.raw('appHomeFactoryFactoryClient.line63JsxTextSelfDrivingCompanies')}</h1>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line69JsxTextNotToolsNotAgentsNotWorkflowsCompaniesWith')}</p>
        </Reveal>

        <Divider />

        {/* ── The ratio ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line80JsxTextTheRatio')}</h2>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="flex gap-10 sm:gap-16 mb-6">
            <Stat value="76%" label={tHardcodedUi.raw('appHomeFactoryFactoryClient.line86JsxAttrLabelAgentsDoingTheWork')} />
            <Stat value="24%" label={tHardcodedUi.raw('appHomeFactoryFactoryClient.line87JsxAttrLabelHumansVerifyingSteeringGoverning')} />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line93JsxTextThisIsNotAForecastItIsOur')}</p>
        </Reveal>

        <Divider />

        {/* ── The factory ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line105JsxTextWhatWeMeanByFactory')}</h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line111JsxTextAFactoryIsASystemForTurningInputs')}</p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line118JsxTextYouFeedTheFactoryYourGoalsYourTools')}</p>
        </Reveal>

        <Divider />

        {/* ── The playbook ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line130JsxTextThePlaybook')}</h2>
        </Reveal>

        <div className="flex flex-col gap-7">
          <DoctrineItem
            number="01"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line137JsxAttrTitleMapTheWork')}
            body={tHardcodedUi.raw('appHomeFactoryFactoryClient.line138JsxAttrBodyEveryCompanyHasProcessesThatRunOnHuman')}
          />
          <DoctrineItem
            number="02"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line142JsxAttrTitleBuildTheAgents')}
            body={tHardcodedUi.raw('appHomeFactoryFactoryClient.line143JsxAttrBodyEachProcessBecomesAnAgentNotAChatbot')}
          />
          <DoctrineItem
            number="03"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line147JsxAttrTitleConnectEverything')}
            body={tHardcodedUi.raw('appHomeFactoryFactoryClient.line148JsxAttrBodyAgentsAreOnlyAsPowerfulAsTheTools')}
          />
          <DoctrineItem
            number="04"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line152JsxAttrTitleRunTheLoop')}
            body={<>{tHardcodedUi.raw('appHomeFactoryFactoryClient.line153JsxTextGoalLoopTheAutonomousExecutionLoopAnAgent')}</>}
          />
          <DoctrineItem
            number="05"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line157JsxAttrTitleLetMemoryCompound')}
            body={tHardcodedUi.raw('appHomeFactoryFactoryClient.line158JsxAttrBodyEverySessionEveryDecisionEveryCorrectionIsRetained')}
          />
          <DoctrineItem
            number="06"
            title={tHardcodedUi.raw('appHomeFactoryFactoryClient.line162JsxAttrTitleHumansGovernNotOperate')}
            body={tHardcodedUi.raw('appHomeFactoryFactoryClient.line163JsxAttrBodyTheFinalLayerIsHumanGovernanceReviewingWhat')}
          />
        </div>

        <Divider />

        {/* ── Why we prove it on ourselves ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line172JsxTextHighestConvictionFromHighestExposure')}</h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl mb-4">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line178JsxTextWeRunOurOwnCompanyOnKortixEvery')}</p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line186JsxTextThisIsNotAProductDemoItIs')}</p>
        </Reveal>

        <Divider />

        {/* ── The migration ── */}
        <Reveal>
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-6">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line197JsxTextTheMigration')}</h2>
        </Reveal>

        <Reveal delay={0.05}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line203JsxTextKortixIsInfrastructureThePlatformIsNotThe')}</p>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl mb-4">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line209JsxTextThePointIsTheMigrationFromHumanOperated')}</p>
        </Reveal>

        <Reveal delay={0.15}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line217JsxTextWeThinkEverySeriousCompanyWillMakeThis')}</p>
        </Reveal>

        <Divider />

        {/* ── Closing ── */}
        <Reveal>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mb-5">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line228JsxTextWeAreASmallTeamWeCareThat')}</p>
        </Reveal>

        <Reveal delay={0.08}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">{tHardcodedUi.raw('appHomeFactoryFactoryClient.line236JsxTextIfYouWantToBuildThisWithUs')}{' '}
            <Link
              href="/careers"
              className="text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
            >{tHardcodedUi.raw('appHomeFactoryFactoryClient.line241JsxTextWeAposReHiring')}</Link>
            {' '}{tHardcodedUi.raw('appHomeFactoryFactoryClient.line243JsxTextIfYouWantToRunYourCompanyOn')}{' '}
            <Link
              href="/partnerships"
              className="text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
            >{tHardcodedUi.raw('appHomeFactoryFactoryClient.line248JsxTextReachOut')}</Link>
          </p>
        </Reveal>

      </article>
    </main>
  );
}
