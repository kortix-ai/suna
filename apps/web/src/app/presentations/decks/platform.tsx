'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The Kortix deck — the complete story end to end, styled 1:1 with the marketing
 * site (home + /developers + /enterprise). Same components and vocabulary:
 * marketing Button/Badge, mono-uppercase eyebrows, `font-medium tracking-tight`
 * titles, `rounded-sm` thin-border cards on bg-card, lucide icon features, code
 * windows, KortixGrid / KortixLetterField motifs, KortixAsterisk bullets.
 */

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { cn } from '@/lib/utils';
import {
  ArrowRightIcon as ArrowRight,
  RobotIcon as Bot,
  PackageIcon as Box,
  CubeIcon as Boxes,
  BrainIcon as Brain,
  BuildingsIcon as Building2,
  ClockIcon as Clock,
  CodeSimpleIcon as Code2,
  CopyIcon as Copy,
  FileCodeIcon as FileCode2,
  GitBranchIcon as GitBranch,
  KeyIcon as KeyRound,
  StackIcon as Layers,
  ChatsIcon as MessagesSquare,
  PlugIcon as Plug,
  HardDrivesIcon as Server,
  ShieldIcon as Shield,
  SparkleIcon as Sparkles,
  StorefrontIcon as Store,
  UsersIcon as Users,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
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
  Terminal,
} from '../engine/parts';

// SlideDef is the engine's contract — see engine/deck.tsx.

const SHOT = '/images/landing-showcase/platform';
const DELIV = '/images/landing-showcase';

/* ── shared local bits ─────────────────────────────────────────────────── */

function IconFeature({
  icon: Icon,
  title,
  body,
  className,
}: {
  icon: typeof Bot;
  title: ReactNode;
  body: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('border-border bg-card flex flex-col gap-3 rounded-sm border p-6', className)}
    >
      <Icon className="text-foreground size-5" aria-hidden />
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
    </div>
  );
}

/** Letter-field background wash (hero / closing), exactly like home + enterprise. */
function LetterBg({ seed = 3382 }: { seed?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
      <KortixLetterField seed={seed} />
    </div>
  );
}

/** Copy-style hero install chip (static). */
function InstallChip() {
  return (
    <div className="bg-card flex w-full max-w-xl min-w-0 items-center gap-4 rounded-sm border p-3 px-5">
      <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
        <span className="text-foreground shrink-0 font-mono text-sm">$ </span>
        <span className="text-foreground min-w-0 truncate font-mono text-sm">
          {KORTIX_CLI_INSTALL_COMMAND}
        </span>
      </div>
      <Copy className="text-muted-foreground size-4 shrink-0" />
    </div>
  );
}

/* Feature slide: copy + product screenshot, in the home two-column idiom. */
function FeatureSlide({
  eyebrow,
  title,
  lead,
  bullets,
  shot,
  reverse,
}: {
  eyebrow: string;
  title: ReactNode;
  lead: ReactNode;
  bullets: ReactNode[];
  shot: string;
  reverse?: boolean;
}) {
  return (
    <Slide>
      <div
        className={cn(
          'grid items-center gap-10 lg:grid-cols-2 lg:gap-16',
          reverse && 'lg:[&>*:first-child]:order-2',
        )}
      >
        <div className="space-y-5">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            {title}
          </h2>
          <Lead>{lead}</Lead>
          <Bullets items={bullets} />
        </div>
        <Shot src={shot} alt={typeof title === 'string' ? title : eyebrow} />
      </div>
    </Slide>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */

export function useSlides(): SlideDef[] {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  return [
    /* 1 — COVER ─────────────────────────────────────────────────────────── */
    {
      id: 'cover',
      label: tI18nHardcoded.raw('i18nComplete.textfa8d84566676'),
      node: (
        <Slide className="overflow-hidden">
          <LetterBg seed={3382} />
          <div className="relative z-10 grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-6">
              <KortixLogo variant="logomark" size={28} className="text-foreground" />
              <Badge variant="update" className="rounded">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextAutonomousCompanyOperatingSystem23597d7f',
                )}
              </Badge>
              <h1 className="text-foreground text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextTheAICommandCentera4b5f603',
                )}
                <br />
                <Dim>
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextForYourCompany6715feb7',
                  )}
                </Dim>
              </h1>
              <Lead className="max-w-xl text-lg">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextOneRepoOneConfig711a8921',
                )}
              </Lead>
              <InstallChip />
              <div className="flex flex-wrap gap-3 pt-1">
                <Button size="lg">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextStartBuildinge2f47368',
                  )}
                  <ArrowRight className="size-4" />
                </Button>
                <Button size="lg" variant="secondary">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextTalkToSales159e3ec0',
                  )}
                </Button>
              </div>
            </div>
            <Shot
              src={`${SHOT}/01-command-center.png`}
              alt={tI18nHardcoded.raw('i18nComplete.text0cc8e13decfa')}
            />
          </div>
        </Slide>
      ),
    },

    /* 2 — THE THESIS ────────────────────────────────────────────────────── */
    {
      id: 'thesis',
      label: tI18nHardcoded.raw('i18nComplete.textdcd8874e25da'),
      node: (
        <Slide className="overflow-hidden">
          <LetterBg seed={1182} />
          <div className="relative z-10 space-y-8">
            <Eyebrow>
              {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextTheBetb782bd17')}
            </Eyebrow>
            <h2 className="text-foreground max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight sm:text-5xl">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextACompanyIsGoing0251c6e0',
              )}
            </h2>
            <Lead className="max-w-2xl text-lg">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextNotAMetaphorLiterally9692a187',
              )}
            </Lead>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
              <Panel className="p-6">
                <Eyebrow>
                  {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextWhatItIsf8717422')}
                </Eyebrow>
                <p className="text-foreground mt-2 text-xl font-medium tracking-tight">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextTheAICommandCenterafc65ccf',
                  )}
                </p>
              </Panel>
              <Panel className="p-6">
                <Eyebrow>
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextInPlainLanguage8d30ff19',
                  )}
                </Eyebrow>
                <p className="text-foreground mt-2 text-xl font-medium tracking-tight">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextACloudComputerWhere43543f17',
                  )}
                </p>
              </Panel>
            </div>
          </div>
        </Slide>
      ),
    },

    /* 3 — THE PROBLEM ───────────────────────────────────────────────────── */
    {
      id: 'problem',
      label: tI18nHardcoded.raw('i18nComplete.texte01d77b4a0bd'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowWhyNowbc13f666',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleTheModelsGot3c57220a',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadYouCanHandd5adb800',
            )}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <MiniCard
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrLabelTheToya330cff4',
              )}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleTheToolsAre741f6e6b',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySingleTenantNo0dcfebc3',
              )}
            />
            <MiniCard
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrLabelTheCage4a5a587a',
              )}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleTheLabsRentd4c9dc02',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyCrawlBackTo121d49d4',
              )}
            />
            <MiniCard
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrLabelTheRefusal713e5d74',
              )}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleKortixIsThedce2722e',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyAToyOr30c5182d',
              )}
            />
          </div>
        </Slide>
      ),
    },

    /* 4 — WHAT IT IS ────────────────────────────────────────────────────── */
    {
      id: 'what',
      label: tI18nHardcoded.raw('i18nComplete.text1f36becc3aa7'),
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextWhatItIsf8717422')}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextMostAIToolsGivede7eebf9',
                )}
                <br />
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextKortixGivesYouA2de643b9',
                )}
                <Dim>
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextCommandCenterf5978255',
                  )}
                </Dim>
              </h2>
              <Lead>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextOnePlaceWhereYour1521a0b5',
                )}
              </Lead>
            </div>
            <Panel className="divide-border divide-y">
              {[
                [
                  tI18nHardcoded.raw('i18nComplete.text9f487c7a828e'),
                  tI18nHardcoded.raw('i18nComplete.text92b8d535557e'),
                ],
                [
                  tI18nHardcoded.raw('i18nComplete.text3be3e0ad0943'),
                  tI18nHardcoded.raw('i18nComplete.text4de44e09f00a'),
                ],
                [
                  tI18nHardcoded.raw('i18nComplete.text97eed343805f'),
                  tI18nHardcoded.raw('i18nComplete.text507d494d56bf'),
                ],
                [
                  tI18nHardcoded.raw('i18nComplete.text37d340dd4340'),
                  tI18nHardcoded.raw('i18nComplete.text3e79204a1f60'),
                ],
                [
                  tI18nHardcoded.raw('i18nComplete.text011500bde6d0'),
                  tI18nHardcoded.raw('i18nComplete.text407f9d9c939e'),
                ],
              ].map(([t, b]) => (
                <div key={t} className="flex flex-col gap-1 p-5">
                  <span className="text-foreground text-base font-medium">{t}</span>
                  <span className="text-muted-foreground text-sm leading-relaxed">{b}</span>
                </div>
              ))}
            </Panel>
          </div>
        </Slide>
      ),
    },

    /* 5 — ONE COMPANY, ONE REPO ─────────────────────────────────────────── */
    {
      id: 'repo',
      label: tI18nHardcoded.raw('i18nComplete.texta086ad00c629'),
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextOpenCodeNativeb4d960fb',
                )}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextYourWholeCompanyAs85afa322',
                )}
              </h2>
              <Lead>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextAKortixProjectIsa8e122a4',
                )}
                <em>{tI18nHardcoded.raw('i18nComplete.textfa51fd49abf6')}</em>{' '}
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextTheCompanyTheWhole7610bc22',
                )}
              </Lead>
              <Bullets
                items={[
                  <>
                    <Mono>{tI18nHardcoded.raw('i18nComplete.text1965f383021e')}</Mono>{' '}
                    {tI18nHardcoded.raw(
                      'autoAppPresentationSlidesPlatformJsxTextTheKortixLayerSandboxca190b4e',
                    )}
                  </>,
                  <>
                    <Mono>{tI18nHardcoded.raw('i18nComplete.text46c0b3f64f0d')}</Mono>{' '}
                    {tI18nHardcoded.raw(
                      'autoAppPresentationSlidesPlatformJsxTextTheRuntimeAgentsSkillscceeb26a',
                    )}
                  </>,
                  tI18nHardcoded.raw('i18nComplete.textac4059cfd550'),
                  tI18nHardcoded.raw('i18nComplete.textb5aad44ae08f'),
                ]}
              />
            </div>
            <Terminal
              title={tI18nHardcoded.raw('i18nComplete.text1965f383021e')}
              lines={[
                { kind: 'comment', text: tI18nHardcoded.raw('i18nComplete.text61f28ba7b5a4') },
                { kind: 'out', text: '' },
                { kind: 'out', text: 'project:' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.textff874fb0b49f') },
                { kind: 'out', text: '' },
                { kind: 'comment', text: tI18nHardcoded.raw('i18nComplete.text609079a06653') },
                { kind: 'out', text: 'triggers:' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.textdceafd500b4c') },
                { kind: 'out', text: '' },
                { kind: 'comment', text: tI18nHardcoded.raw('i18nComplete.text31aa7515d0ce') },
                { kind: 'out', text: 'connectors:' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text3228c7f267a6') },
              ]}
            />
          </div>
        </Slide>
      ),
    },

    /* 6 — THE LOOP ──────────────────────────────────────────────────────── */
    {
      id: 'loop',
      label: tI18nHardcoded.raw('i18nComplete.textea7f71782388'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowTheCoreLoop29905493',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleProjectSessionSandboxee8af285',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadWorkReachesMain11f15aad',
            )}
          />
          <div className="mt-12 flex flex-wrap items-stretch gap-3">
            {[
              [
                'project',
                tI18nHardcoded.raw('i18nComplete.textc684e335b50d'),
                tI18nHardcoded.raw('i18nComplete.textf3503deebf69'),
              ],
              [
                'session',
                tI18nHardcoded.raw('i18nComplete.text9e796567bf87'),
                tI18nHardcoded.raw('i18nComplete.textc5cd6589dcd7'),
              ],
              ['agent', 'OpenCode', tI18nHardcoded.raw('i18nComplete.text7f33545ae2eb')],
              [
                tI18nHardcoded.raw('i18nComplete.textb6e3ca291ec2'),
                tI18nHardcoded.raw('i18nComplete.text3e032ee7d1dd'),
                tI18nHardcoded.raw('i18nComplete.text591967ee7f66'),
              ],
              ['main', tI18nHardcoded.raw('i18nComplete.text6024f479d0dc'), 'self-improves'],
            ].map(([k, t, s], i, arr) => (
              <div key={k as string} className="flex items-center gap-3">
                <Panel
                  className={cn(
                    'min-w-[170px] p-4',
                    k === 'change request' && 'bg-foreground text-background',
                  )}
                >
                  <span
                    className={cn(
                      'font-mono text-xs',
                      k === 'change request' ? 'text-background/70' : 'text-muted-foreground',
                    )}
                  >
                    {k}
                  </span>
                  <div className="mt-1 text-lg font-medium tracking-tight">{t}</div>
                  <div
                    className={cn(
                      'text-xs',
                      k === 'change request' ? 'text-background/70' : 'text-muted-foreground',
                    )}
                  >
                    {s}
                  </div>
                </Panel>
                {i < arr.length - 1 ? (
                  <ArrowRight className="text-muted-foreground/50 size-5 shrink-0" />
                ) : null}
              </div>
            ))}
          </div>
          <Lead className="mt-10 max-w-3xl">
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextEverySessionRunsIn56bf7294',
            )}
          </Lead>
        </Slide>
      ),
    },

    /* 7 — HOW A SESSION WORKS ───────────────────────────────────────────── */
    {
      id: 'session',
      label: tI18nHardcoded.raw('i18nComplete.text090051628ce4'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowUnderTheHood3e9e9bca',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleEverySessionIs5e5fc280',
            )}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              ['01', 'Boot', tI18nHardcoded.raw('i18nComplete.text802370076d02')],
              ['02', 'Materialize', tI18nHardcoded.raw('i18nComplete.text4c1f87ad0ffa')],
              [
                '03',
                tI18nHardcoded.raw('i18nComplete.textc6d640399b61'),
                tI18nHardcoded.raw('i18nComplete.text351c94634971'),
              ],
              [
                '04',
                tI18nHardcoded.raw('i18nComplete.textce7da5716908'),
                tI18nHardcoded.raw('i18nComplete.text991d9a57288f'),
              ],
            ].map(([k, t, b]) => (
              <Panel key={k} className="flex flex-col gap-2 p-6">
                <LabelChip>{k}</LabelChip>
                <h3 className="text-foreground mt-1 text-lg font-medium tracking-tight">{t}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{b}</p>
              </Panel>
            ))}
          </div>
          <Lead className="mt-10 max-w-3xl">
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextASyncEngineMirrors66aaf7a1',
            )}
          </Lead>
        </Slide>
      ),
    },

    /* 8 — PARALLELISM ───────────────────────────────────────────────────── */
    {
      id: 'parallel',
      label: tI18nHardcoded.raw('i18nComplete.text69585fb8aa14'),
      node: (
        <Slide className="overflow-hidden">
          <LetterBg seed={5521} />
          <div className="relative z-10 space-y-8">
            <Eyebrow>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextThePartNobodyElse57b93089',
              )}
            </Eyebrow>
            <h2 className="text-foreground max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight sm:text-5xl">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextThousandsOfAgentsOne23279dee',
              )}
              <Dim>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextZeroCrossover86ad5f52',
                )}
              </Dim>
            </h2>
            <Lead className="max-w-2xl text-lg">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextRunThousandsOfAgents9a3f93e4',
              )}
            </Lead>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
              {[
                ['∞', tI18nHardcoded.raw('i18nComplete.text4debcf7369ac')],
                ['1', tI18nHardcoded.raw('i18nComplete.text92553541af30')],
                [
                  tI18nHardcoded.raw('i18nComplete.text9408211c997f'),
                  tI18nHardcoded.raw('i18nComplete.textc5c7cdb85034'),
                ],
              ].map(([v, l]) => (
                <Panel key={l} className="p-6">
                  <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
                    {v}
                  </div>
                  <div className="text-muted-foreground mt-2 text-sm">{l}</div>
                </Panel>
              ))}
            </div>
            <Lead className="text-muted-foreground/80">
              {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextThisIsTheOnly74f58f8b')}
            </Lead>
          </div>
        </Slide>
      ),
    },

    /* 9 — COMMAND CENTER OVERVIEW ───────────────────────────────────────── */
    {
      id: 'command-center',
      label: tI18nHardcoded.raw('i18nComplete.text2522f9d16f3b'),
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <SectionHead
                eyebrow={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrEyebrowWhatSInc726d2c3',
                )}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleOnePlaceYourf7c09691',
                )}
              />
              <div className="divide-border border-border bg-card divide-y rounded-sm border">
                {(
                  [
                    [Bot, 'Agents', tI18nHardcoded.raw('i18nComplete.textd180271bed63')],
                    [Sparkles, 'Skills', tI18nHardcoded.raw('i18nComplete.textbeff1e4ca7a0')],
                    [Plug, 'Connectors', tI18nHardcoded.raw('i18nComplete.text7f8252af886d')],
                    [KeyRound, 'Secrets', tI18nHardcoded.raw('i18nComplete.textd2acf4ac763b')],
                    [
                      MessagesSquare,
                      'Channels',
                      tI18nHardcoded.raw('i18nComplete.text4a1ca4f91111'),
                    ],
                    [Clock, 'Triggers', tI18nHardcoded.raw('i18nComplete.text276e88f0f37e')],
                    [Brain, 'Memory', tI18nHardcoded.raw('i18nComplete.textf354ef2ee567')],
                  ] as [typeof Bot, string, string][]
                ).map(([Icon, t, b]) => (
                  <div key={t} className="flex items-center gap-3 px-5 py-3">
                    <Icon className="text-foreground size-4 shrink-0" aria-hidden />
                    <span className="text-foreground text-sm font-medium">{t}</span>
                    <span className="text-muted-foreground text-sm">— {b}</span>
                  </div>
                ))}
              </div>
            </div>
            <Shot
              src={`${SHOT}/01-command-center.png`}
              alt={tI18nHardcoded.raw('i18nComplete.text0cc8e13decfa')}
            />
          </div>
        </Slide>
      ),
    },

    /* 10 — AGENTS */
    {
      id: 'agents',
      label: tI18nHardcoded.raw('i18nComplete.text279b44d2ab4b'),
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterAgentse0677a55',
          )}
          title={tI18nHardcoded.raw('i18nComplete.text279b44d2ab4b')}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadMarkdownPersonasWith298b95be',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.textf08a83aac6c4'),
            tI18nHardcoded.raw('i18nComplete.textb5ca3585c03b'),
            tI18nHardcoded.raw('i18nComplete.textbe70d00c8928'),
          ]}
          shot={`${SHOT}/05-agents.png`}
        />
      ),
    },

    /* 11 — SKILLS */
    {
      id: 'skills',
      label: tI18nHardcoded.raw('i18nComplete.text66d0f523a379'),
      node: (
        <FeatureSlide
          reverse
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterSkillse923e1ca',
          )}
          title={tI18nHardcoded.raw('i18nComplete.text66d0f523a379')}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadThePartThat99be6c94',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.text07331645370f'),
            tI18nHardcoded.raw('i18nComplete.text9590cb5df0a8'),
            tI18nHardcoded.raw('i18nComplete.textdbd9b1773511'),
          ]}
          shot={`${SHOT}/04-skills.png`}
        />
      ),
    },

    /* 12 — CONNECTORS */
    {
      id: 'connectors',
      label: tI18nHardcoded.raw('i18nComplete.textc3d2e79ebdd0'),
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterConnectorscc0dd429',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleConnectEverythingOnce90dc9225',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLead1ClickConnectbd49b095',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.text449992e55737'),
            tI18nHardcoded.raw('i18nComplete.text8ddaaf20bb7d'),
            tI18nHardcoded.raw('i18nComplete.textb68f7b640d93'),
          ]}
          shot={`${SHOT}/03-connectors.png`}
        />
      ),
    },

    /* 13 — SECRETS */
    {
      id: 'secrets',
      label: tI18nHardcoded.raw('i18nComplete.textd8707d411d99'),
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextCommandCenterSecrets582ab7fe',
                )}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextOneTokenNotNinetya67633e0',
                )}
              </h2>
              <Lead>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextKeysOAuthAndModel44974f3c',
                )}
              </Lead>
              <Bullets
                items={[
                  tI18nHardcoded.raw('i18nComplete.text5ebe32e1b916'),
                  tI18nHardcoded.raw('i18nComplete.text2fea30b8d515'),
                  tI18nHardcoded.raw('i18nComplete.text5731d8c0fb14'),
                ]}
              />
            </div>
            <div className="flex flex-col items-center gap-5">
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  tI18nHardcoded.raw('i18nComplete.text9c05aa57c149'),
                  tI18nHardcoded.raw('i18nComplete.text7ad1511cc614'),
                  tI18nHardcoded.raw('i18nComplete.text5872277e15ce'),
                  tI18nHardcoded.raw('i18nComplete.textee9c0bf3dfee'),
                  tI18nHardcoded.raw('i18nComplete.text98dd14248eba'),
                  tI18nHardcoded.raw('i18nComplete.text8128f44ac0d3'),
                ].map((k) => (
                  <span
                    key={k}
                    className="border-border bg-card text-muted-foreground rounded-sm border px-3 py-1.5 font-mono text-xs line-through"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <ArrowRight className="text-muted-foreground/50 size-5 rotate-90" />
              <div className="bg-foreground text-background rounded-sm px-7 py-4 font-mono text-lg font-medium">
                {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxText1KORTIXTOKEN7cd8465b')}
              </div>
              <ArrowRight className="text-muted-foreground/50 size-5 rotate-90" />
              <Pill>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextSandboxScopedAudited1023f72c',
                )}
              </Pill>
            </div>
          </div>
        </Slide>
      ),
    },

    /* 14 — CHANNELS */
    {
      id: 'channels',
      label: tI18nHardcoded.raw('i18nComplete.text4c8906cf76f5'),
      node: (
        <FeatureSlide
          reverse
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterChannels1e28ad0b',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleWhereYourPeople5a92eefb',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadSlackTeamsTelegram3e7973c3',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.textcf885bfcd8a4'),
            tI18nHardcoded.raw('i18nComplete.text009cb0fc376f'),
            tI18nHardcoded.raw('i18nComplete.textbe0fce7637ce'),
          ]}
          shot={`${SHOT}/06-channels.png`}
        />
      ),
    },

    /* 15 — TRIGGERS */
    {
      id: 'triggers',
      label: tI18nHardcoded.raw('i18nComplete.texte62f2148a64d'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterTriggers9dd9b5f3',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleItRunsWithout0222686a',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadCronAndSignedc7137017',
            )}
          />
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <Pill>
                <Clock className="size-3.5" /> {tI18nHardcoded.raw('i18nComplete.textdd9d24965dbe')}
              </Pill>
              <Shot
                src={`${SHOT}/08-schedules.png`}
                alt={tI18nHardcoded.raw('i18nComplete.textcfee87726b0a')}
              />
            </div>
            <div className="space-y-3">
              <Pill>
                <Webhook className="size-3.5" />{' '}
                {tI18nHardcoded.raw('i18nComplete.text4814f62c108d')}
              </Pill>
              <Shot
                src={`${SHOT}/09-webhooks.png`}
                alt={tI18nHardcoded.raw('i18nComplete.text4f1601d68eb4')}
              />
            </div>
          </div>
        </Slide>
      ),
    },

    /* 16 — CHANGE REQUESTS */
    {
      id: 'changes',
      label: tI18nHardcoded.raw('i18nComplete.text91f850fa869b'),
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowHowWorkLands0010e2ce',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleChangeRequests6e5aad55',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadTheReviewedMerge785e3799',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.text9a1ffabd3658'),
            tI18nHardcoded.raw('i18nComplete.text6d6fb78e4419'),
            tI18nHardcoded.raw('i18nComplete.textb88cae951498'),
          ]}
          shot={`${SHOT}/07-changes.png`}
        />
      ),
    },

    /* 17 — MEMORY */
    {
      id: 'memory',
      label: tI18nHardcoded.raw('i18nComplete.textc3963aedaac6'),
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextCommandCenterMemoryb48a08fa',
                )}
              </Eyebrow>
              <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextALivingCompanyBrain7ed9d8a3',
                )}
              </h2>
              <Lead>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextFilesForNowAndf51cbec0',
                )}
              </Lead>
              <Bullets
                items={[
                  tI18nHardcoded.raw('i18nComplete.text90cc8430dca3'),
                  tI18nHardcoded.raw('i18nComplete.text844d1616ac93'),
                  tI18nHardcoded.raw('i18nComplete.textea94f48d89d0'),
                ]}
              />
            </div>
            <Terminal
              title={tI18nHardcoded.raw('i18nComplete.text2ea11daa7745')}
              lines={[
                { kind: 'comment', text: '---' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text821fc05f30c8') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text5667e2fe3cb5') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text96f660c6ea36') },
                { kind: 'comment', text: '---' },
                { kind: 'out', text: '' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text40223a3c6277') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text742ae8324623') },
              ]}
            />
          </div>
        </Slide>
      ),
    },

    /* 18 — TEAM & PERMISSIONS */
    {
      id: 'team',
      label: tI18nHardcoded.raw('i18nComplete.texta8aa23313d75'),
      node: (
        <FeatureSlide
          reverse
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowMembersGroupsRolesed169530',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleAWorkforceYou8e9267ec',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadARealAccountc271c3da',
          )}
          bullets={[
            tI18nHardcoded.raw('i18nComplete.textb9b2cc46e71e'),
            tI18nHardcoded.raw('i18nComplete.textf7d76d648261'),
            tI18nHardcoded.raw('i18nComplete.text2a462ba2ae5e'),
          ]}
          shot={`${SHOT}/02-team.png`}
        />
      ),
    },

    /* 19 — THREE WAYS WORK RUNS */
    {
      id: 'modes',
      label: tI18nHardcoded.raw('i18nComplete.text744b88e04bcc'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowHowTheWork5f427097',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleThreeWaysThe38c4ef16',
            )}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              [
                'On-demand',
                tI18nHardcoded.raw('i18nComplete.textd8a321e980e7'),
                tI18nHardcoded.raw('i18nComplete.texte5c56bc61eb0'),
              ],
              [
                'Human-assisted',
                tI18nHardcoded.raw('i18nComplete.text1bf354f2b825'),
                tI18nHardcoded.raw('i18nComplete.text9aef8ba99514'),
              ],
              [
                'Automated',
                tI18nHardcoded.raw('i18nComplete.textbded910328ad'),
                tI18nHardcoded.raw('i18nComplete.text043cf55ca745'),
              ],
            ].map(([t, lead, b], i) => (
              <Panel
                key={t}
                className={cn(
                  'flex flex-col gap-2 p-6',
                  i === 1 && 'bg-foreground text-background',
                )}
              >
                <span
                  className={cn(
                    'font-mono text-xs tracking-wider',
                    i === 1 ? 'text-background/70' : 'text-muted-foreground',
                  )}
                >
                  0{i + 1}
                </span>
                <h3 className="mt-1 text-2xl font-medium tracking-tight">{t}</h3>
                <p
                  className={cn(
                    'text-sm font-medium',
                    i === 1 ? 'text-background' : 'text-foreground',
                  )}
                >
                  {lead}
                </p>
                <p
                  className={cn(
                    'text-sm leading-relaxed',
                    i === 1 ? 'text-background/70' : 'text-muted-foreground',
                  )}
                >
                  {b}
                </p>
              </Panel>
            ))}
          </div>
          <Lead className="mt-8">
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextPoliciesDecideWhatRunsdea9e686',
            )}
          </Lead>
        </Slide>
      ),
    },

    /* 20 — REAL DELIVERABLES */
    {
      id: 'deliverables',
      label: tI18nHardcoded.raw('i18nComplete.textbab76032fb5d'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowRealWorkNot1f83090a',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleAgentsReturnFinished8d0f12c2',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadNotATranscript07b7fc10',
            )}
          />
          <div className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-5">
            {[
              ['slides', 'Slides'],
              ['research', 'Research'],
              ['data', 'Data'],
              ['docs', 'Docs'],
              ['images', 'Images'],
            ].map(([f, label]) => (
              <div key={f} className="space-y-2">
                <Shot src={`${DELIV}/${f}.png`} alt={label} chrome={false} />
                <p className="text-muted-foreground text-center font-mono text-xs">{label}</p>
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 21 — START WITH ONE AGENT */
    {
      id: 'use-cases',
      label: tI18nHardcoded.raw('i18nComplete.text4d8f5abc42f5'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowInternalAgentsc33e77c7',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleStartWithOne2fe53fe5',
            )}
            lead={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadEachIsA2eb95c3b')}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[
              [
                'Support',
                tI18nHardcoded.raw('i18nComplete.texta19b856c93ad'),
                tI18nHardcoded.raw('i18nComplete.text2c93dc393e24'),
              ],
              [
                'Engineering',
                tI18nHardcoded.raw('i18nComplete.text424dfcf4d7e8'),
                tI18nHardcoded.raw('i18nComplete.textcda73ce6e6aa'),
              ],
              [
                'Research',
                tI18nHardcoded.raw('i18nComplete.textecaddb9a540f'),
                tI18nHardcoded.raw('i18nComplete.textc9a4928a4d78'),
              ],
              [
                'Finance',
                tI18nHardcoded.raw('i18nComplete.textf059fcbba4af'),
                tI18nHardcoded.raw('i18nComplete.text8654b486889c'),
              ],
              [
                'Marketing',
                tI18nHardcoded.raw('i18nComplete.text15e74e0985a0'),
                tI18nHardcoded.raw('i18nComplete.text16a36eea2e4e'),
              ],
              [
                'Operations',
                tI18nHardcoded.raw('i18nComplete.textfaa24cb6ca58'),
                tI18nHardcoded.raw('i18nComplete.textbbbc664ba1ca'),
              ],
            ].map(([tag, title, body]) => (
              <MiniCard key={tag} label={tag} title={title} body={body} />
            ))}
          </div>
        </Slide>
      ),
    },

    /* 22 — TWO WAYS IN */
    {
      id: 'two-ways',
      label: tI18nHardcoded.raw('i18nComplete.text12cef29dfa4d'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowTwoWaysIn3552a350',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleBuildersConfigureTeams883f9aee',
            )}
          />
          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            <Panel className="space-y-4 p-8">
              <Code2 className="text-foreground size-5" />
              <h3 className="text-foreground text-2xl font-medium tracking-tight">
                {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextForBuildersc84efc99')}
              </h3>
              <p className="text-foreground text-sm">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextConfigureItLikeSoftwaredfe3974f',
                )}
              </p>
              <Lead className="text-sm">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextDefineAgentsSkillsToolscf60a61c',
                )}
              </Lead>
              <Bullets
                index={1}
                items={[
                  tI18nHardcoded.raw('i18nComplete.textb78b4d8cdf7e'),
                  tI18nHardcoded.raw('i18nComplete.texte65ac57c0c16'),
                  tI18nHardcoded.raw('i18nComplete.textc92025bd3eeb'),
                ]}
              />
            </Panel>
            <Panel inverted className="space-y-4 p-8">
              <MessagesSquare className="text-background size-5" />
              <h3 className="text-background text-2xl font-medium tracking-tight">
                {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextForTeams733bb9d9')}
              </h3>
              <p className="text-background text-sm">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextUseItLikeChat53e3e05e',
                )}
              </p>
              <p className="text-background/70 text-sm leading-relaxed">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextGiveEveryTeamAgentsea166472',
                )}
              </p>
              <ul className="text-background/80 space-y-2 text-sm leading-relaxed">
                {[
                  tI18nHardcoded.raw('i18nComplete.text602ff50f0ec1'),
                  tI18nHardcoded.raw('i18nComplete.text88098ef371c2'),
                  tI18nHardcoded.raw('i18nComplete.text4ee510d053d5'),
                ].map((it) => (
                  <li key={it} className="flex gap-2">
                    <span className="bg-background/40 mt-2 size-1.5 shrink-0 rounded-full" />
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </Slide>
      ),
    },

    /* 23 — EVERY SURFACE */
    {
      id: 'surfaces',
      label: tI18nHardcoded.raw('i18nComplete.texteb7aa5b77168'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowEverywhereYourTeam780b5c60',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleChatSlackTeams59488d51',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadYourTeamTalkse4dd114d',
            )}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              tI18nHardcoded.raw('i18nComplete.texta535409d22df'),
              tI18nHardcoded.raw('i18nComplete.text429bbfa117e2'),
              'Slack',
              tI18nHardcoded.raw('i18nComplete.texta7b52b269a23'),
              tI18nHardcoded.raw('i18nComplete.texte27a31ed1d6f'),
              tI18nHardcoded.raw('i18nComplete.text78f322ab2971'),
            ].map((s) => (
              <div
                key={s}
                className="border-border bg-card flex items-center gap-3 rounded-sm border px-6 py-5"
              >
                <span className="bg-foreground size-2 rounded-full" />
                <span className="text-foreground text-sm font-medium">{s}</span>
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 24 — FOR DEVELOPERS */
    {
      id: 'developers',
      label: tI18nHardcoded.raw('i18nComplete.text6f79cf5c144a'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowForDevelopersff49cef3',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleBuiltOnFiles64c977e2',
            )}
            lead={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadNoSDKToca0b7d2f')}
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <Terminal
              title={tI18nHardcoded.raw('i18nComplete.text6f37eb69ebc8')}
              lines={[
                { kind: 'comment', text: '---' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text5346918b32c0') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text035549be9e10') },
                { kind: 'comment', text: '---' },
                { kind: 'out', text: '' },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text9c84074599b5') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text4a01fea7c629') },
                { kind: 'out', text: tI18nHardcoded.raw('i18nComplete.text14f1b7cb49a1') },
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <IconFeature
                icon={Boxes}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleAgentsAreSandboxes6c23b7e5',
                )}
                body={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyEachRunsIn8ed57783',
                )}
              />
              <IconFeature
                icon={FileCode2}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleWorkIsCodecab734a3',
                )}
                body={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyAgentsSkillsTriggerse8dad872',
                )}
              />
              <IconFeature
                icon={GitBranch}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleKortixInitShip24f086f1',
                )}
                body={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyScaffoldAProject47c3905e',
                )}
              />
              <IconFeature
                icon={Server}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleYouOwnThe34e7b932',
                )}
                body={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyOpenAndSource3344f24a',
                )}
              />
            </div>
          </div>
        </Slide>
      ),
    },

    /* 25 — SELF-HOST */
    {
      id: 'self-host',
      label: tI18nHardcoded.raw('i18nComplete.text37a5d04181b5'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowOpenSelfHostablef9aa286a',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleSameProductEverywhere41c9494d',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadRunKortixOn048c2e1e',
            )}
          />
          <div className="mt-10 grid items-center gap-6 lg:grid-cols-2">
            <Terminal
              title={tI18nHardcoded.raw('i18nComplete.text7859cc3ee2ae')}
              lines={[
                { kind: 'cmd', text: tI18nHardcoded.raw('i18nComplete.textdbef6cc84fef') },
                { kind: 'cmd', text: tI18nHardcoded.raw('i18nComplete.text299438afe0c2') },
                { kind: 'comment', text: tI18nHardcoded.raw('i18nComplete.texted9f27637609') },
              ]}
            />
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  [Server, tI18nHardcoded.raw('i18nComplete.textf513ed1619ec')],
                  [Building2, tI18nHardcoded.raw('i18nComplete.text63a9ae000680')],
                  [Box, 'On-prem'],
                  [Shield, tI18nHardcoded.raw('i18nComplete.text1b00fe7ae5e3')],
                ] as [typeof Server, string][]
              ).map(([Icon, h], i) => (
                <div
                  key={h}
                  className={cn(
                    'flex items-center gap-3 rounded-sm border px-5 py-4',
                    i === 0
                      ? 'border-border bg-foreground text-background'
                      : 'border-border bg-card',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="text-sm font-medium">{h}</span>
                </div>
              ))}
            </div>
          </div>
        </Slide>
      ),
    },

    /* 26 — ENTERPRISE & SECURITY */
    {
      id: 'enterprise',
      label: tI18nHardcoded.raw('i18nComplete.text6bcb11c1c5d8'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowEnterpriseSecurityc11469d2',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleTheArchitectureIs4fc258b0',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadBuiltToSurvive7727b9f7',
            )}
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <IconFeature
              icon={Shield}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleHardIsolationd585df5c',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBody1Session1d6ad1454',
              )}
            />
            <IconFeature
              icon={KeyRound}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOneToken5d68cf6a',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyYourAPIKeyscd9e6087',
              )}
            />
            <IconFeature
              icon={GitBranch}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleAuditEverything3be9d076',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyEveryModelCall8c86019e',
              )}
            />
            <IconFeature
              icon={Building2}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOwnYourDatab56eaad9',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySelfHostVPC21d0cda0',
              )}
            />
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {[
              tI18nHardcoded.raw('i18nComplete.text188fba3516ee'),
              tI18nHardcoded.raw('i18nComplete.text60f41540d80e'),
              tI18nHardcoded.raw('i18nComplete.textf23e2655e76b'),
              tI18nHardcoded.raw('i18nComplete.text228d1d7e87d4'),
              tI18nHardcoded.raw('i18nComplete.textf982a576e7c6'),
              tI18nHardcoded.raw('i18nComplete.text2c4de2851235'),
              tI18nHardcoded.raw('i18nComplete.text0f8c0eb8cc5e'),
            ].map((c) => (
              <Pill key={c}>{c}</Pill>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 27 — WHO IT'S FOR */
    {
      id: 'audiences',
      label: tI18nHardcoded.raw('i18nComplete.text60c3907ec269'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowWhoItSaacd126b',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleOnePlatformFour98163905',
            )}
          />
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {(
              [
                [Code2, 'Developers', tI18nHardcoded.raw('i18nComplete.text474945c326bd')],
                [Users, 'Companies', tI18nHardcoded.raw('i18nComplete.text82203da566c7')],
                [Shield, 'Enterprise', tI18nHardcoded.raw('i18nComplete.text777e112466d3')],
                [
                  Building2,
                  tI18nHardcoded.raw('i18nComplete.text827f9d2d8e74'),
                  tI18nHardcoded.raw('i18nComplete.texta21221a2eef4'),
                ],
              ] as [typeof Code2, string, string][]
            ).map(([Icon, t, b]) => (
              <IconFeature key={t} icon={Icon} title={t} body={b} />
            ))}
          </div>
        </Slide>
      ),
    },

    /* 28 — THE BUSINESS */
    {
      id: 'business',
      label: tI18nHardcoded.raw('i18nComplete.text507e19ce6f1b'),
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowHowThisBecomesd07e3c68',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleThePlatformIsfa2254a2',
            )}
            lead={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrLeadWeBuildOur3a652ae7',
            )}
          />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <IconFeature
              icon={Code2}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOpenSourced5df9dc2',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySelfHostableUnderneathb975d6f7',
              )}
            />
            <IconFeature
              icon={Layers}
              title={tI18nHardcoded.raw('i18nComplete.textb977b950c1ae')}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySeatsCompute61f703c9',
              )}
            />
            <IconFeature
              icon={Shield}
              title={tI18nHardcoded.raw('i18nComplete.textf5828f35ad93')}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyRunItAnywhere9c8c4cd2',
              )}
            />
            <IconFeature
              icon={Store}
              title={tI18nHardcoded.raw('i18nComplete.textc608981d8d68')}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyAgentsSkillsWholedd8eefbc',
              )}
            />
            <IconFeature
              icon={Boxes}
              title={tI18nHardcoded.raw('i18nComplete.textfb791d3beeee')}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyTheComputeFloora3af4e83',
              )}
            />
          </div>
          <Lead className="text-muted-foreground/80 mt-8">
            {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextTheLabsArePaid7834c27f')}
          </Lead>
        </Slide>
      ),
    },

    /* 29 — CLOSING */
    {
      id: 'closing',
      label: tI18nHardcoded.raw('i18nComplete.textf79ebae4aae3'),
      node: (
        <Slide className="overflow-hidden">
          <div className="pointer-events-none absolute inset-0 z-0 mask-y-from-80% mask-x-from-90% opacity-60">
            <KortixGrid count={58} seed={4228} />
          </div>
          <div className="relative z-10 space-y-8">
            <KortixLogo variant="symbol" size={40} className="text-foreground" />
            <h2 className="text-foreground max-w-4xl text-4xl leading-[1.12] font-medium tracking-tight sm:text-5xl">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextWeReBuildingTheda31c271',
              )}{' '}
              <Dim>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextAndLetsItKeep69d7479b',
                )}
              </Dim>
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextStartBuildinge2f47368',
                )}
                <ArrowRight className="size-4" />
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/enterprise">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextTalkToSales159e3ec0',
                  )}
                </Link>
              </Button>
              <span className="text-muted-foreground ml-1 font-mono text-sm">
                {tI18nHardcoded.raw('i18nComplete.text97eb27bdb657')}
              </span>
            </div>
            <p className="text-muted-foreground font-mono text-xs tracking-wider">
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextOpenSourceSSORBAC8718a667',
              )}
            </p>
          </div>
        </Slide>
      ),
    },
  ];
}
