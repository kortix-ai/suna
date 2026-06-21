'use client';

import { useTranslations } from 'next-intl';
/**
 * The Kortix deck — content & structure follow the official "Kortix pres ENG"
 * sales narrative (origin → what it is → interface → shared machine →
 * connect/configure/deploy → no model lock-in → Slack/Teams → use cases →
 * thanks), rendered in the marketing-site visual style (home / developers /
 * enterprise): marketing Badge, mono eyebrows, font-medium tracking-tight
 * titles, rounded-sm thin-border cards, KortixAsterisk bullets, KortixGrid /
 * KortixLetterField motifs, real product screenshots.
 */

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { cn } from '@/lib/utils';
import {
  Boxes,
  Briefcase,
  Cpu,
  Database,
  Plug,
  Rocket,
  SlidersHorizontal,
  Star,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Bullets,
  Dim,
  Eyebrow,
  LabelChip,
  Lead,
  MiniCard,
  Mono,
  Panel,
  Pill,
  SectionHead,
  Shot,
  Slide,
} from './parts';

export type SlideDef = { id: string; label: string; node: ReactNode };

const SHOT = '/images/landing-showcase/platform';

/* ── local bits ─────────────────────────────────────────────────────────── */

function IconFeature({
  icon: Icon,
  step,
  title,
  body,
  className,
}: {
  icon: typeof Plug;
  step?: string;
  title: ReactNode;
  body: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('border-border bg-card flex flex-col gap-3 rounded-sm border p-6', className)}
    >
      <div className="flex items-center justify-between">
        <Icon className="text-foreground size-5" aria-hidden />
        {step ? (
          <span className="text-muted-foreground font-mono text-xs tracking-wider">{step}</span>
        ) : null}
      </div>
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p>
    </div>
  );
}

function StatBlock({
  value,
  label,
  icon: Icon,
}: {
  value: ReactNode;
  label: ReactNode;
  icon?: typeof Star;
}) {
  return (
    <Panel className="flex flex-col gap-1 p-6">
      {Icon ? <Icon className="text-muted-foreground mb-1 size-4" aria-hidden /> : null}
      <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
        {value}
      </div>
      <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
        {label}
      </div>
    </Panel>
  );
}

function LetterBg({ seed = 3382 }: { seed?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
      <KortixLetterField seed={seed} />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */

export function useSlides(): SlideDef[] {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  return [
    /* 1 — COVER ─────────────────────────────────────────────────────────── */
    {
      id: 'cover',
      label: 'Cover',
      node: (
        <Slide className="overflow-hidden">
          <LetterBg seed={3382} />
          <div className="relative z-10 max-w-4xl space-y-7">
            <KortixLogo variant="logomark" size={30} className="text-foreground" />
            <Badge variant="update" className="rounded">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxTextAutonomousCompanyOperatingSystem84a0b7da',
              )}
            </Badge>
            <h1 className="text-foreground text-5xl leading-[1.08] font-medium tracking-tight md:text-6xl">
              {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextTheAICommandCentera5f1f9b6')}
              <br />
              <Dim>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextForYourCompany25d27be8')}
              </Dim>
            </h1>
            <Lead className="max-w-xl text-lg">
              {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextOnePlaceToBuild6874ebc8')}
            </Lead>
          </div>
        </Slide>
      ),
    },

    /* 2 — ORIGIN STORY ──────────────────────────────────────────────────── */
    {
      id: 'origin',
      label: 'Origin',
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrEyebrowHowWeGot7d55e2ea',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitleApril2025We5a8b8958',
            )}
            lead={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrLeadTheFirstOpen5ca53ab1')}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatBlock icon={Users} value="400K+" label="Users" />
            <StatBlock
              icon={Star}
              value="~20K"
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrLabelGitHubStars281bbe4f',
              )}
            />
            <StatBlock
              icon={Wallet}
              value="$4M"
              label={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrLabelRaisedUS2fe5bf64')}
            />
            <StatBlock
              icon={Boxes}
              value="Microsoft"
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrLabelViaGitHubFund874e057f',
              )}
            />
          </div>
        </Slide>
      ),
    },

    /* 3 — WHAT IS KORTIX TODAY ───────────────────────────────────────────── */
    {
      id: 'what',
      label: 'What is Kortix',
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextSoWhatIsKortixf6e68e29')}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesEngJsxTextTheAICommandCenteraa567525',
                )}
              </h2>
              <Lead>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextACommandCenterFor5691f67e')}
              </Lead>
              <Bullets
                items={[
                  'Connect the tools your company runs on',
                  'Invite the team — people and agents are principals',
                  'Agents work on your internal data, in one place',
                ]}
              />
            </div>
            <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
          </div>
        </Slide>
      ),
    },

    /* 4 — PLATFORM INTERFACE OVERVIEW ────────────────────────────────────── */
    {
      id: 'platform',
      label: 'Platform overview',
      node: (
        <Slide>
          <SectionHead
            eyebrow="Platform"
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitlePlatformInterfaceOverview68617c3b',
            )}
          />
          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {(
              [
                ['01 · Primary agent interface', `${SHOT}/01-command-center.png`],
                ['02 · Workspace settings', `${SHOT}/02-team.png`],
                ['03 · Agent configuration', `${SHOT}/05-agents.png`],
              ] as [string, string][]
            ).map(([label, src]) => (
              <div key={label} className="space-y-3">
                <LabelChip>{label}</LabelChip>
                <Shot src={src} alt={label} />
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 5 — A SHARED MACHINE ───────────────────────────────────────────────── */
    {
      id: 'shared-machine',
      label: 'A shared machine',
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrEyebrowTheModele0cce1a2',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitleASharedMachinef4a64064',
            )}
          />
          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            <Panel className="flex flex-col gap-4 p-8">
              <div className="flex items-center gap-3">
                <Database className="text-foreground size-5" />
                <span className="text-muted-foreground font-mono text-xs tracking-wider">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesEngJsxText01SHAREDKNOWLEDGE1256f17c',
                  )}
                </span>
              </div>
              <h3 className="text-foreground text-2xl font-medium tracking-tight">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesEngJsxTextOneEnvironmentOneBrainf89f5247',
                )}
              </h3>
              <Lead className="text-[15px]">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesEngJsxTextDataFilesCredentialsAndc512985f',
                )}
              </Lead>
            </Panel>
            <Panel className="flex flex-col gap-4 p-8">
              <div className="flex items-center gap-3">
                <Users className="text-foreground size-5" />
                <span className="text-muted-foreground font-mono text-xs tracking-wider">
                  {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxText02WORKFORCE25abe51f')}
                </span>
              </div>
              <h3 className="text-foreground text-2xl font-medium tracking-tight">
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextAnAgentForEvery428d6526')}
              </h3>
              <Lead className="text-[15px]">
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextOnTopOfThisc9248b98')}
              </Lead>
            </Panel>
          </div>
        </Slide>
      ),
    },

    /* 6 — CONNECT · CONFIGURE · DEPLOY ───────────────────────────────────── */
    {
      id: 'how',
      label: 'Connect · Configure · Deploy',
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrEyebrowHowItWorksdb0e191d',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitleConnectConfigureDeploy54b71922',
            )}
          />
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            <IconFeature
              icon={Plug}
              step={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrStep01CONNECT9911758f')}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleYouConnectCompany944f7b6f',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyEmailCRMERP925457da',
              )}
            />
            <IconFeature
              icon={SlidersHorizontal}
              step={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrStep02CONFIGUREc04c4777',
              )}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleConfigureAgentsAndd883aee9',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyAgentsForEveryd6808402',
              )}
            />
            <IconFeature
              icon={Rocket}
              step={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrStep03DEPLOY3cae2a50')}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleAgentsWorkAutonomouslye5cb7f7a',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBody247Autonomousfad6bf9a',
              )}
            />
          </div>
        </Slide>
      ),
    },

    /* 7 — NO MODEL LOCK-IN ──────────────────────────────────────────────── */
    {
      id: 'models',
      label: 'No model lock-in',
      node: (
        <Slide>
          <SectionHead
            eyebrow="Models"
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitleNoModelLock5cbe3d84',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrLeadTheCompanyChoosesd934d520',
            )}
          />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            <MiniCard
              label="Configuration"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitlePickYourProvider8452d8cd',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyChooseTheProvider485f153b',
              )}
            />
            <MiniCard
              label="Flexibility"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleSwitchInReal9708c591',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodySwitchModelsIne5bdf218',
              )}
            />
            <MiniCard
              label="Costs"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleYourTokensOr58f6d79d',
              )}
              body={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrBodyUseYourOwna0a32148')}
            />
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
              Bring
            </span>
            {['OpenAI', 'Anthropic', 'Google', 'Your own keys', 'On-prem'].map((p) => (
              <Pill key={p}>
                <Cpu className="size-3.5" /> {p}
              </Pill>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 8 — WHERE KORTIX LIVES ────────────────────────────────────────────── */
    {
      id: 'lives',
      label: 'Where Kortix lives',
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextWhereKortixLives366879fa')}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesEngJsxTextInsideSlackAndMicrosoftf6088064',
                )}
              </h2>
              <Lead>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextInstallKortixAsA355cd3e1')}
              </Lead>
              <div className="flex flex-wrap gap-2">
                <Pill>Slack</Pill>
                <Pill>
                  {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextMicrosoftTeams5bea06db')}
                </Pill>
                <Pill>
                  {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextWebMobile7b86dcc0')}
                </Pill>
              </div>
            </div>
            <Shot src={`${SHOT}/06-channels.png`} alt="Kortix inside Slack and Teams" />
          </div>
        </Slide>
      ),
    },

    /* 9 — USE CASES ─────────────────────────────────────────────────────── */
    {
      id: 'use-cases',
      label: 'Use cases',
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrEyebrowUseCasesd96e576f',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesEngJsxAttrTitleThreeUseCases88bd381c',
            )}
            lead={tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxAttrLeadEachAgentHasa063247e')}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <IconFeature
              icon={Briefcase}
              step="SALES"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleASalesAgentb126b58b',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyResearchesAccountsDrafts1e3ad491',
              )}
            />
            <IconFeature
              icon={Wallet}
              step="FINANCE"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleAFinanceAgentb10006e4',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyReconcilesTransactionsFlags3fe87d2a',
              )}
            />
            <IconFeature
              icon={UserRound}
              step="HR"
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrTitleAnHRAgentc69f4dae',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesEngJsxAttrBodyOnboardsNewHiresd9d535ee',
              )}
            />
          </div>
        </Slide>
      ),
    },

    /* 10 — CLOSING ──────────────────────────────────────────────────────── */
    {
      id: 'closing',
      label: 'Thank you',
      node: (
        <Slide className="overflow-hidden">
          <div className="pointer-events-none absolute inset-0 z-0 mask-y-from-80% mask-x-from-90% opacity-60">
            <KortixGrid count={58} seed={4228} />
          </div>
          <div className="relative z-10 space-y-8">
            <KortixLogo variant="symbol" size={44} className="text-foreground" />
            <h2 className="text-foreground text-6xl font-medium tracking-tight">Grazie.</h2>
            <div className="space-y-3">
              <Eyebrow>
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextGetInTouchf319cf34')}
              </Eyebrow>
              <p className="text-foreground text-xl font-medium tracking-tight">
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextTextMeAt7199731f')}
                <Mono className="text-kortix-blue">
                  {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextDomKortixAi2c244da6')}
                </Mono>{' '}
                {tI18nHardcoded.raw('autoAppPresentationSlidesEngJsxTextOrOnLinkedIn13b1c035')}
              </p>
              <p className="text-muted-foreground font-mono text-sm">kortix.com</p>
            </div>
          </div>
        </Slide>
      ),
    },
  ];
}
