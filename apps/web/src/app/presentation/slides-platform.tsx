'use client';

import { useTranslations } from 'next-intl';
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
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  Bot,
  Box,
  Boxes,
  Brain,
  Building2,
  Clock,
  Code2,
  Copy,
  FileCode2,
  GitBranch,
  KeyRound,
  Layers,
  MessagesSquare,
  Plug,
  Server,
  Shield,
  Sparkles,
  Store,
  Users,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
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
  Terminal,
} from './parts';

export type SlideDef = { id: string; label: string; node: ReactNode };

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
      <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p>
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="bg-card flex w-full max-w-xl min-w-0 items-center gap-4 rounded-sm border p-3 px-5">
      <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
        <span className="text-foreground shrink-0 font-mono text-sm">$ </span>
        <span className="text-foreground min-w-0 truncate font-mono text-sm">
          {tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextCurlFsSLHttpsKortix8ac787c7',
          )}
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
      label: 'Cover',
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
                <Button size="xl">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextStartBuildinge2f47368',
                  )}
                  <ArrowRight className="size-4" />
                </Button>
                <Button size="xl" variant="secondary">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextTalkToSales159e3ec0',
                  )}
                </Button>
              </div>
            </div>
            <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
          </div>
        </Slide>
      ),
    },

    /* 2 — THE THESIS ────────────────────────────────────────────────────── */
    {
      id: 'thesis',
      label: 'The thesis',
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
                'autoAppPresentationSlidesPlatformJsxTextNotAMetaphorLiterallyfe00d18c',
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
      label: 'The problem',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadYouCanHandbb3ac5b5',
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
      label: 'What it is',
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
                  'autoAppPresentationSlidesPlatformJsxTextOnePlaceWhereYourb6eb078d',
                )}
              </Lead>
            </div>
            <Panel className="divide-border divide-y">
              {[
                [
                  'Open & yours',
                  'Open source and self-hostable. Your data, your models, your infra.',
                ],
                ['A workforce, not one assistant', 'Org-scale specialists that run in parallel.'],
                [
                  'Real work, not chat',
                  'Agents run on real computers and return finished deliverables.',
                ],
                [
                  'Everything is code',
                  'Versioned, reviewable, portable — grep your entire company.',
                ],
                [
                  'Bring your own models',
                  'Any provider, your keys, or the subscription you already pay for.',
                ],
              ].map(([t, b]) => (
                <div key={t} className="flex flex-col gap-1 p-5">
                  <span className="text-foreground text-base font-medium">{t}</span>
                  <span className="text-muted-foreground text-[15px] leading-relaxed">{b}</span>
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
      label: 'One repo',
      node: (
        <Slide>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-5">
              <Eyebrow>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextRuntimeNativeb4d960fb',
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
                <em>is</em>{' '}
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextTheCompanyTheWhole7610bc22',
                )}
              </Lead>
              <Bullets
                items={[
                  <>
                    <Mono>kortix.yaml</Mono>{' '}
                    {tI18nHardcoded.raw(
                      'autoAppPresentationSlidesPlatformJsxTextTheKortixLayerSandboxca190b4e',
                    )}
                  </>,
                  <>
                    <Mono>.kortix/opencode/</Mono>{' '}
                    {tI18nHardcoded.raw(
                      'autoAppPresentationSlidesPlatformJsxTextTheRuntimeAgentsSkillscceeb26a',
                    )}
                  </>,
                  'Every change versioned, reviewable, reversible',
                  'Self-host on your cloud, VPC, or on-prem — no lock-in',
                ]}
              />
            </div>
            <Terminal
              title="kortix.yaml"
              lines={[
                { kind: 'comment', text: 'kortix_version: 2' },
                { kind: 'out', text: '' },
                { kind: 'out', text: 'project:' },
                { kind: 'out', text: '  name: acme' },
                { kind: 'out', text: '' },
                { kind: 'comment', text: '# a trigger runs itself, on a schedule' },
                { kind: 'out', text: 'triggers:' },
                { kind: 'out', text: '  - type: cron  agent: research' },
                { kind: 'out', text: '' },
                { kind: 'comment', text: '# connect a tool’s API as agent tools' },
                { kind: 'out', text: 'connectors:' },
                { kind: 'out', text: '  - slug: stripe  provider: http' },
              ]}
            />
          </div>
        </Slide>
      ),
    },

    /* 6 — THE LOOP ──────────────────────────────────────────────────────── */
    {
      id: 'loop',
      label: 'The core loop',
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
              ['project', 'git repo', 'kortix.yaml + config'],
              ['session', 'isolated sandbox', 'its own branch'],
              ['agent', 'Runtime', 'works · commits · pushes'],
              ['change request', 'you review', 'approve to merge'],
              ['main', 'always up', 'self-improves'],
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
                      'font-mono text-xs tracking-wider uppercase',
                      k === 'change request' ? 'text-background/70' : 'text-muted-foreground',
                    )}
                  >
                    {k}
                  </span>
                  <div className="mt-1 text-lg font-medium tracking-tight">{t}</div>
                  <div
                    className={cn(
                      'text-[13px]',
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
      label: 'How a session works',
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
              [
                '01',
                'Boot',
                'A sandbox boots from one generic snapshot already running the kortix-sandbox-agent-server daemon.',
              ],
              [
                '02',
                'Materialize',
                'The daemon clones the repo, cuts a fresh branch, and reads kortix.yaml + Runtime config into a live runtime.',
              ],
              [
                '03',
                'Work, walled off',
                'The agent gets a ready machine and works — fully isolated. Run fifty and they never touch each other.',
              ],
              [
                '04',
                'Land it',
                'To keep something, it commits and opens a change request toward main. A human decides whether it lands.',
              ],
            ].map(([k, t, b]) => (
              <Panel key={k} className="flex flex-col gap-2 p-6">
                <LabelChip>{k}</LabelChip>
                <h3 className="text-foreground mt-1 text-lg font-medium tracking-tight">{t}</h3>
                <p className="text-muted-foreground text-[15px] leading-relaxed">{b}</p>
              </Panel>
            ))}
          </div>
          <Lead className="mt-10 max-w-3xl">
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextASyncEngineMirrors849c4a89',
            )}
          </Lead>
        </Slide>
      ),
    },

    /* 8 — PARALLELISM ───────────────────────────────────────────────────── */
    {
      id: 'parallel',
      label: 'Parallelism',
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
                'autoAppPresentationSlidesPlatformJsxTextRunThousandsOfAgents14f1f102',
              )}
            </Lead>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
              {[
                ['∞', 'parallel sessions, fully isolated'],
                ['1', 'shared config they all run on'],
                ['1 → main', 'reviewed change at a time'],
              ].map(([v, l]) => (
                <Panel key={l} className="p-6">
                  <div className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
                    {v}
                  </div>
                  <div className="text-muted-foreground mt-2 text-[15px]">{l}</div>
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
      label: 'Command center',
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
                    [Bot, 'Agents', 'Markdown personas with a scoped reach into tools.'],
                    [Sparkles, 'Skills', 'Reusable know-how that rides into every session.'],
                    [Plug, 'Connectors', '3,000+ apps through one scoped token.'],
                    [KeyRound, 'Secrets', 'Encrypted, scoped, never shown to the model.'],
                    [MessagesSquare, 'Channels', 'Slack & chat surfaces, one click.'],
                    [Clock, 'Triggers', 'Cron and signed webhooks spawn sessions.'],
                    [Brain, 'Memory', 'A living company brain that compounds.'],
                  ] as [typeof Bot, string, string][]
                ).map(([Icon, t, b]) => (
                  <div key={t} className="flex items-center gap-3 px-5 py-3">
                    <Icon className="text-foreground size-4 shrink-0" aria-hidden />
                    <span className="text-foreground text-[15px] font-medium">{t}</span>
                    <span className="text-muted-foreground text-[15px]">— {b}</span>
                  </div>
                ))}
              </div>
            </div>
            <Shot src={`${SHOT}/01-command-center.png`} alt="The Kortix command center" />
          </div>
        </Slide>
      ),
    },

    /* 10 — AGENTS */
    {
      id: 'agents',
      label: 'Agents',
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterAgentse0677a55',
          )}
          title="Agents"
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadMarkdownPersonasWithb049eae2',
          )}
          bullets={[
            'A persona is just a markdown file you can read',
            'Scoped permissions per agent — people and agents are principals',
            'Any agent can edit its own config and propose the change',
          ]}
          shot={`${SHOT}/05-agents.png`}
        />
      ),
    },

    /* 11 — SKILLS */
    {
      id: 'skills',
      label: 'Skills',
      node: (
        <FeatureSlide
          reverse
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterSkillse923e1ca',
          )}
          title="Skills"
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadThePartThate3f9d8d9',
          )}
          bullets={[
            'Reusable know-how that lives in the repo',
            'Rides into every session automatically',
            'Skills and memory accumulate with every run',
          ]}
          shot={`${SHOT}/04-skills.png`}
        />
      ),
    },

    /* 12 — CONNECTORS */
    {
      id: 'connectors',
      label: 'Connectors',
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowCommandCenterConnectorscc0dd429',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleConnectEverythingOnce90dc9225',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLead1ClickConnect89e2184c',
          )}
          bullets={[
            '3,000+ apps in a click',
            'Bring any MCP, OpenAPI, GraphQL, or HTTP tool',
            'Scoped per person, per agent, per team — and audited',
          ]}
          shot={`${SHOT}/03-connectors.png`}
        />
      ),
    },

    /* 13 — SECRETS */
    {
      id: 'secrets',
      label: 'Secrets',
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
                  'autoAppPresentationSlidesPlatformJsxTextKeysOAuthAndModel515700d5',
                )}
              </Lead>
              <Bullets
                items={[
                  'Your API keys never enter a sandbox',
                  'Agents act through a single scoped Kortix token',
                  'Allow, ask-first, or block — network rules you control',
                ]}
              />
            </div>
            <div className="flex flex-col items-center gap-5">
              <div className="flex flex-wrap justify-center gap-2">
                {['STRIPE_…', 'GITHUB_…', 'OPENAI_…', 'SLACK_…', 'AWS_…', 'LINEAR_…'].map((k) => (
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
      label: 'Channels',
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
            'autoAppPresentationSlidesPlatformJsxAttrLeadSlackTeamsTelegram921f192a',
          )}
          bullets={[
            'One click stands up a bot in your workspace',
            'It starts real sessions from a chat thread',
            'A Slack message can turn into a shipped change request',
          ]}
          shot={`${SHOT}/06-channels.png`}
        />
      ),
    },

    /* 15 — TRIGGERS */
    {
      id: 'triggers',
      label: 'Triggers',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadCronAndSignedef829b40',
            )}
          />
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <Pill>
                <Clock className="size-3.5" /> Cron
              </Pill>
              <Shot src={`${SHOT}/08-schedules.png`} alt="Scheduled triggers" />
            </div>
            <div className="space-y-3">
              <Pill>
                <Webhook className="size-3.5" /> Webhook
              </Pill>
              <Shot src={`${SHOT}/09-webhooks.png`} alt="Webhook triggers" />
            </div>
          </div>
        </Slide>
      ),
    },

    /* 16 — CHANGE REQUESTS */
    {
      id: 'changes',
      label: 'Change requests',
      node: (
        <FeatureSlide
          eyebrow={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrEyebrowHowWorkLands0010e2ce',
          )}
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleChangeRequests6e5aad55',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadTheReviewedMerge6e1bf5c5',
          )}
          bullets={[
            'Nothing reaches main without a human approving it',
            'Every change — human or agent — is a commit you can diff and revert',
            'The audit trail isn’t bolted on; it’s the repo itself',
          ]}
          shot={`${SHOT}/07-changes.png`}
        />
      ),
    },

    /* 17 — MEMORY */
    {
      id: 'memory',
      label: 'Memory',
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
                  'autoAppPresentationSlidesPlatformJsxTextFilesForNowAnd3cce010d',
                )}
              </Lead>
              <Bullets
                items={[
                  'Plain files today — readable, diffable, versioned',
                  'Compounds what it learns over every run',
                  'The company gets smarter — and it’s all tracked',
                ]}
              />
            </div>
            <Terminal
              title="memory/customer-acme.md"
              lines={[
                { kind: 'comment', text: '---' },
                { kind: 'out', text: 'name: Acme Corp' },
                { kind: 'out', text: 'plan: Enterprise' },
                { kind: 'out', text: 'renewal: 2026-09-01' },
                { kind: 'comment', text: '---' },
                { kind: 'out', text: '' },
                { kind: 'out', text: 'Prefers async updates. Owner: Dana.' },
                { kind: 'out', text: 'Flagged refund policy Q2 — resolved.' },
              ]}
            />
          </div>
        </Slide>
      ),
    },

    /* 18 — TEAM & PERMISSIONS */
    {
      id: 'team',
      label: 'Team & permissions',
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
            'autoAppPresentationSlidesPlatformJsxAttrLeadARealAccount68e2c515',
          )}
          bullets={[
            'Per-resource permissions for every person and agent',
            'SSO, RBAC, and groups that match your org',
            'Sessions are owned by whoever — or whatever — started them',
          ]}
          shot={`${SHOT}/02-team.png`}
        />
      ),
    },

    /* 19 — THREE WAYS WORK RUNS */
    {
      id: 'modes',
      label: 'Three ways work runs',
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
                'Ask in chat, get it now.',
                'You prompt a session and the agent returns the deliverable.',
              ],
              [
                'Human-assisted',
                'It works and checks in.',
                'The agent does the work and pauses for the calls that matter.',
              ],
              [
                'Automated',
                'Runs end to end.',
                'A schedule or trigger fires a session with no one watching.',
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
                    'text-[15px] font-medium',
                    i === 1 ? 'text-background' : 'text-foreground',
                  )}
                >
                  {lead}
                </p>
                <p
                  className={cn(
                    'text-[15px] leading-relaxed',
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
      label: 'Real deliverables',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadNotATranscriptb68e5a86',
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
                <p className="text-muted-foreground text-center font-mono text-xs tracking-wider uppercase">
                  {label}
                </p>
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 21 — START WITH ONE AGENT */
    {
      id: 'use-cases',
      label: 'Start with one agent',
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
                'A support agent that closes tickets.',
                'Drafts a reply from your docs, flags refunds for approval.',
              ],
              [
                'Engineering',
                'An engineering agent that ships fixes.',
                'Reviews the PR, opens a fix branch, submits a change request.',
              ],
              [
                'Research',
                'A research agent that briefs your team.',
                'Gathers from approved sources and posts a brief before the call.',
              ],
              [
                'Finance',
                'A finance agent that closes the month.',
                'Reconciles transactions, flags exceptions, holds for sign-off.',
              ],
              [
                'Marketing',
                'A marketing agent that runs the brief.',
                'Turns a brief into drafts, then routes them for review.',
              ],
              [
                'Operations',
                'An operations agent that runs the SOP.',
                'Runs each step in a sandbox, pausing at every approval gate.',
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
      label: 'Two ways in',
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
              <p className="text-foreground text-[15px]">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextConfigureItLikeSoftwaredfe3974f',
                )}
              </p>
              <Lead className="text-[15px]">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextDefineAgentsSkillsToolscf60a61c',
                )}
              </Lead>
              <Bullets
                index={1}
                items={[
                  'Your stack, your models, your keys',
                  'Skills, tools & policies as code',
                  'Self-host or managed cloud',
                ]}
              />
            </Panel>
            <Panel inverted className="space-y-4 p-8">
              <MessagesSquare className="text-background size-5" />
              <h3 className="text-background text-2xl font-medium tracking-tight">
                {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextForTeams733bb9d9')}
              </h3>
              <p className="text-background text-[15px]">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextUseItLikeChat53e3e05e',
                )}
              </p>
              <p className="text-background/70 text-[15px] leading-relaxed">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextGiveEveryTeamAgentsea166472',
                )}
              </p>
              <ul className="text-background/80 space-y-2 text-[15px] leading-relaxed">
                {[
                  'As easy as a chat app',
                  'Approvals before agents act',
                  'Your data and config stay yours',
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
      label: 'Every surface',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadYourTeamTalkse1fe3252',
            )}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              'Web workspace',
              'Mobile app',
              'Slack',
              'Microsoft Teams',
              'API & SDK',
              'Triggers (cron & webhook)',
            ].map((s) => (
              <div
                key={s}
                className="border-border bg-card flex items-center gap-3 rounded-sm border px-6 py-5"
              >
                <span className="bg-foreground size-2 rounded-full" />
                <span className="text-foreground text-[15px] font-medium">{s}</span>
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 24 — FOR DEVELOPERS */
    {
      id: 'developers',
      label: 'For developers',
      node: (
        <Slide>
          <SectionHead
            eyebrow={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrEyebrowForDevelopersff49cef3',
            )}
            title={tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxAttrTitleBuiltOnFiles64c977e2',
            )}
            lead={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadNoSDKTo91b0c136')}
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <Terminal
              title="agent.md"
              lines={[
                { kind: 'comment', text: '---' },
                { kind: 'out', text: 'description: Acme’s support agent.' },
                { kind: 'out', text: 'model: anthropic/claude-opus-4-8' },
                { kind: 'comment', text: '---' },
                { kind: 'out', text: '' },
                { kind: 'out', text: 'Resolve customer tickets end to end.' },
                { kind: 'out', text: 'Issue refunds under $500 on your own.' },
                { kind: 'out', text: 'Anything higher goes to a human.' },
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
      label: 'Self-host',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadRunKortixOn275c3486',
            )}
          />
          <div className="mt-10 grid items-center gap-6 lg:grid-cols-2">
            <Terminal
              title="self-host"
              lines={[
                { kind: 'cmd', text: 'kortix self-host start' },
                { kind: 'cmd', text: 'kortix hosts use local   # ↔  cloud' },
                { kind: 'comment', text: '# your data, your models, your keys' },
              ]}
            />
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  [Server, 'Managed cloud'],
                  [Building2, 'Your VPC'],
                  [Box, 'On-prem'],
                  [Shield, 'Air-gapped'],
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
                  <span className="text-[15px] font-medium">{h}</span>
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
      label: 'Enterprise & security',
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
              'MicroVM isolation',
              'SSO · RBAC · groups',
              'Per-resource permissions',
              'Secrets manager',
              'Human approval gates',
              'Full audit trail',
              'On-prem / VPC / air-gapped',
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
      label: "Who it's for",
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
                [
                  Code2,
                  'Developers',
                  'A managed cloud for Runtime, Claude, and Codex agents. kortix init, kortix ship. Bring the subscription you already pay for; every PR gets a preview you can click through.',
                ],
                [
                  Users,
                  'Companies',
                  'A workforce they can actually manage — reached from web, Slack, or Teams — on infrastructure where the data, config, and model belong to the company, not a vendor.',
                ],
                [
                  Shield,
                  'Enterprise',
                  'Built to survive a security review: microVM isolation, real members/groups/roles, per-resource permissions, a secrets manager, audit trail, approval gates.',
                ],
                [
                  Building2,
                  'Agencies & consultancies',
                  'One horizontal platform sold through verticalized partners with their own front ends and starter templates. A franchise for the part of the economy about to be rebuilt.',
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
      label: 'The business',
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
              'autoAppPresentationSlidesPlatformJsxAttrLeadWeBuildOur02b8fdeb',
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
              title="Cloud"
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySeatsCompute61f703c9',
              )}
            />
            <IconFeature
              icon={Shield}
              title="Single-tenant"
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyRunItAnywhere9c8c4cd2',
              )}
            />
            <IconFeature
              icon={Store}
              title="Marketplace"
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyAgentsSkillsWholedd8eefbc',
              )}
            />
            <IconFeature
              icon={Boxes}
              title="Platinum.dev"
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
      label: 'Closing',
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
              <Button size="xl">
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextStartBuildinge2f47368',
                )}
                <ArrowRight className="size-4" />
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href="/enterprise">
                  {tI18nHardcoded.raw(
                    'autoAppPresentationSlidesPlatformJsxTextTalkToSales159e3ec0',
                  )}
                </Link>
              </Button>
              <span className="text-muted-foreground ml-1 font-mono text-sm">kortix.com</span>
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
