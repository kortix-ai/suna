'use client';

/**
 * The Kortix product deck: the complete story end to end, 29 slides, no builds.
 *
 * Frame: engine/frame.tsx, the landing page at 16:9. Every slide is a
 * two-tone `Slide` title, an optional one-sentence `sub`, and one band that
 * holds the artifact: hairline `Cells`, `Rows`, a `Shot` or `Code`. No
 * eyebrow, no badge, no motif, no reveal motion. Glyphs are Phosphor, as on
 * the landing's pillars band.
 *
 * Screenshots: only the files under public/images/landing-showcase exist.
 * The triggers, change-request, docs and images screenshots were removed
 * from public/ (e44db9fb23); those slides carry cells or code instead.
 *
 * Copy is translated (`hardcodedUi`). Do not add a literal user-facing
 * string here: `scripts/audit-i18n.mjs --max-hardcoded=0` must stay at 0.
 */

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { KORTIX_CLI_INSTALL_COMMAND } from '@kortix/ui/internal/lib/kortix-cli';
import {
  RobotIcon as Bot,
  PackageIcon as Box,
  CubeIcon as Boxes,
  BrainIcon as Brain,
  BuildingsIcon as Building2,
  CheckIcon,
  ClockIcon as Clock,
  CodeSimpleIcon as Code2,
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
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import { Cell, Cells, Code, Mono, Rows, Shot, Slide } from '../engine/frame';

const SHOT = '/images/landing-showcase/platform';
const DELIV = '/images/landing-showcase';
/** The shell named on a `Code` block: a program name, not copy. */
const SHELL = 'zsh';

/* ── local cells, built from frame parts ───────────────────────────────── */

type Glyph = typeof Bot;

/** A `Cell` led by a Phosphor glyph, as on the landing's pillars band. */
function IconCell({
  icon: Icon,
  title,
  children,
}: {
  icon: Glyph;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Cell label={<Icon className="text-foreground size-5" aria-hidden />} title={title}>
      {children}
    </Cell>
  );
}

/** One number and what it counts. Lives inside `Cells`. */
function StatCell({ value, children }: { value: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-background flex flex-col gap-3 p-6 lg:p-8">
      <span className="text-foreground text-4xl font-medium tracking-tight tabular-nums">
        {value}
      </span>
      <span className="text-muted-foreground text-sm">{children}</span>
    </div>
  );
}

/** The pillars-band cell: glyph, two-tone name, body, checked facts. */
function PillarCell({
  icon: Icon,
  name,
  line,
  body,
  facts,
}: {
  icon: Glyph;
  name: ReactNode;
  line: ReactNode;
  body: ReactNode;
  facts: readonly string[];
}) {
  return (
    <div className="bg-background flex flex-col gap-5 p-6 lg:p-10">
      <Icon className="text-foreground size-6" aria-hidden />
      <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
        {name}
        <span className="text-muted-foreground block text-lg">{line}</span>
      </h3>
      <p className="text-muted-foreground text-base text-pretty">{body}</p>
      <Facts items={facts} className="flex-col" />
    </div>
  );
}

/** Checked facts, as on the landing's pillars band. */
function Facts({ items, className }: { items: readonly string[]; className?: string }) {
  return (
    <ul className={cn('flex gap-2 text-sm', className)}>
      {items.map((fact) => (
        <li key={fact} className="text-foreground flex items-start gap-2">
          <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {fact}
        </li>
      ))}
    </ul>
  );
}

/** A band line under the artifact: one sentence, muted. */
function BandNote({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground mt-8 max-w-3xl text-base text-pretty">{children}</p>;
}

/** A product feature: a screenshot beside three facts as stacked cells. */
function FeatureSlide({
  title,
  lead,
  facts,
  shot,
  reverse,
}: {
  title: string;
  lead: ReactNode;
  facts: readonly ReactNode[];
  shot: string;
  reverse?: boolean;
}) {
  return (
    <Slide title={title} sub={lead}>
      <div className="grid gap-6 lg:grid-cols-12">
        <Shot src={shot} alt={title} className={cn('lg:col-span-8', reverse && 'lg:order-2')} />
        <Cells className="lg:col-span-4 lg:grid-rows-3">
          {facts.map((fact, i) => (
            <Cell key={i} title={fact} />
          ))}
        </Cells>
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
        <Slide
          size="cover"
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextTheAICommandCentera4b5f603',
          )}
          titleMuted={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextForYourCompany6715feb7',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextOneRepoOneConfig711a8921',
          )}
        >
          <div className="grid items-start gap-6 lg:grid-cols-12">
            <Code
              title={SHELL}
              lines={[`$ ${KORTIX_CLI_INSTALL_COMMAND}`]}
              className="lg:col-span-5"
            />
            <Shot
              src={`${SHOT}/01-command-center.png`}
              alt={tI18nHardcoded.raw('i18nComplete.text0cc8e13decfa')}
              className="lg:col-span-7"
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
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextACompanyIsGoing0251c6e0',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextNotAMetaphorLiterally9692a187',
          )}
        >
          <Cells className="lg:grid-cols-2">
            <Cell
              label={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextWhatItIsf8717422')}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextTheAICommandCenterafc65ccf',
              )}
            />
            <Cell
              label={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextInPlainLanguage8d30ff19',
              )}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextACloudComputerWhere43543f17',
              )}
            />
          </Cells>
        </Slide>
      ),
    },

    /* 3 — THE PROBLEM ───────────────────────────────────────────────────── */
    {
      id: 'problem',
      label: tI18nHardcoded.raw('i18nComplete.texte01d77b4a0bd'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleTheModelsGot3c57220a',
          )}
          sub={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadYouCanHandd5adb800')}
        >
          <Cells className="lg:grid-cols-3">
            {[
              [
                tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLabelTheToya330cff4'),
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleTheToolsAre741f6e6b',
                ),
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodySingleTenantNo0dcfebc3',
                ),
              ],
              [
                tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLabelTheCage4a5a587a'),
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleTheLabsRentd4c9dc02',
                ),
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyCrawlBackTo121d49d4',
                ),
              ],
              [
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrLabelTheRefusal713e5d74',
                ),
                tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleKortixIsThedce2722e',
                ),
                tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrBodyAToyOr30c5182d'),
              ],
            ].map(([label, title, body]) => (
              <Cell key={label} label={label} title={title}>
                {body}
              </Cell>
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* 4 — WHAT IT IS ────────────────────────────────────────────────────── */
    {
      id: 'what',
      label: tI18nHardcoded.raw('i18nComplete.text1f36becc3aa7'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextMostAIToolsGivede7eebf9',
          )}
          titleMuted={
            <>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextKortixGivesYouA2de643b9',
              )}{' '}
              {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextCommandCenterf5978255')}
            </>
          }
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextOnePlaceWhereYour1521a0b5',
          )}
        >
          <Rows
            rows={[
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
            ].map(([k, v]) => ({ id: k, k, v }))}
          />
        </Slide>
      ),
    },

    /* 5 — ONE COMPANY, ONE REPO ─────────────────────────────────────────── */
    {
      id: 'repo',
      label: tI18nHardcoded.raw('i18nComplete.texta086ad00c629'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextYourWholeCompanyAs85afa322',
          )}
          sub={
            <>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextAKortixProjectIsa8e122a4',
              )}{' '}
              <em>{tI18nHardcoded.raw('i18nComplete.textfa51fd49abf6')}</em>{' '}
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextTheCompanyTheWhole7610bc22',
              )}
            </>
          }
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Code
              title={tI18nHardcoded.raw('i18nComplete.text1965f383021e')}
              className="lg:col-span-5"
              lines={[
                'project:',
                tI18nHardcoded.raw('i18nComplete.textff874fb0b49f'),
                ' ',
                tI18nHardcoded.raw('i18nComplete.text609079a06653'),
                'triggers:',
                tI18nHardcoded.raw('i18nComplete.textdceafd500b4c'),
                ' ',
                tI18nHardcoded.raw('i18nComplete.text31aa7515d0ce'),
                'connectors:',
                tI18nHardcoded.raw('i18nComplete.text3228c7f267a6'),
              ]}
            />
            <Cells className="lg:col-span-7 lg:grid-cols-2">
              <Cell title={<Mono>{tI18nHardcoded.raw('i18nComplete.text1965f383021e')}</Mono>}>
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextTheKortixLayerSandboxca190b4e',
                )}
              </Cell>
              <Cell
                title={
                  <Mono>
                    {tI18nHardcoded.raw('i18nComplete.text21025012cda7')}{' '}
                    {tI18nHardcoded.raw('i18nComplete.textf1e8d760c12c')}
                  </Mono>
                }
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextTheRuntimeAgentsSkillscceeb26a',
                )}
              </Cell>
              <Cell title={tI18nHardcoded.raw('i18nComplete.textac4059cfd550')} />
              <Cell title={tI18nHardcoded.raw('i18nComplete.textb5aad44ae08f')} />
            </Cells>
          </div>
        </Slide>
      ),
    },

    /* 6 — THE LOOP ──────────────────────────────────────────────────────── */
    {
      id: 'loop',
      label: tI18nHardcoded.raw('i18nComplete.textea7f71782388'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleProjectSessionSandboxee8af285',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadWorkReachesMain11f15aad',
          )}
        >
          <Cells className="lg:grid-cols-5">
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
              [
                'agent',
                tI18nHardcoded.raw('i18nComplete.textf2c4b4f22668'),
                tI18nHardcoded.raw('i18nComplete.text7f33545ae2eb'),
              ],
              [
                tI18nHardcoded.raw('i18nComplete.textb6e3ca291ec2'),
                tI18nHardcoded.raw('i18nComplete.text3e032ee7d1dd'),
                tI18nHardcoded.raw('i18nComplete.text591967ee7f66'),
              ],
              ['main', tI18nHardcoded.raw('i18nComplete.text6024f479d0dc'), 'self-improves'],
            ].map(([k, title, s]) => (
              <Cell key={k} label={k} title={title}>
                {s}
              </Cell>
            ))}
          </Cells>
          <BandNote>
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextEverySessionRunsIn56bf7294',
            )}
          </BandNote>
        </Slide>
      ),
    },

    /* 7 — HOW A SESSION WORKS ───────────────────────────────────────────── */
    {
      id: 'session',
      label: tI18nHardcoded.raw('i18nComplete.text090051628ce4'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleEverySessionIs5e5fc280',
          )}
        >
          <Cells className="lg:grid-cols-4">
            {[
              ['01', 'Boot', tI18nHardcoded.raw('i18nComplete.text802370076d02')],
              ['02', 'Materialize', tI18nHardcoded.raw('i18nComplete.text554ee79d14bc')],
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
            ].map(([k, title, body]) => (
              <Cell key={k} label={k} title={title}>
                {body}
              </Cell>
            ))}
          </Cells>
          <BandNote>
            {tI18nHardcoded.raw(
              'autoAppPresentationSlidesPlatformJsxTextASyncEngineMirrors66aaf7a1',
            )}
          </BandNote>
        </Slide>
      ),
    },

    /* 8 — PARALLELISM ───────────────────────────────────────────────────── */
    {
      id: 'parallel',
      label: tI18nHardcoded.raw('i18nComplete.text69585fb8aa14'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextThousandsOfAgentsOne23279dee',
          )}
          titleMuted={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextZeroCrossover86ad5f52',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextRunThousandsOfAgents9a3f93e4',
          )}
        >
          <Cells className="lg:grid-cols-3">
            {[
              ['∞', tI18nHardcoded.raw('i18nComplete.text4debcf7369ac')],
              ['1', tI18nHardcoded.raw('i18nComplete.text92553541af30')],
              [
                tI18nHardcoded.raw('i18nComplete.text9408211c997f'),
                tI18nHardcoded.raw('i18nComplete.textc5c7cdb85034'),
              ],
            ].map(([v, l]) => (
              <StatCell key={l} value={v}>
                {l}
              </StatCell>
            ))}
          </Cells>
          <BandNote>
            {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextThisIsTheOnly74f58f8b')}
          </BandNote>
        </Slide>
      ),
    },

    /* 9 — CompanyOS OVERVIEW ──────────────────────────────────────────────── */
    {
      id: 'command-center',
      label: tI18nHardcoded.raw('i18nComplete.text2522f9d16f3b'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleOnePlaceYourf7c09691',
          )}
        >
          <div className="grid items-start gap-6 lg:grid-cols-12">
            <Rows
              className="lg:col-span-5 [&_dd]:lg:col-span-7 [&_dt]:lg:col-span-5"
              rows={(
                [
                  [Bot, 'Agents', tI18nHardcoded.raw('i18nComplete.textd180271bed63')],
                  [Sparkles, 'Skills', tI18nHardcoded.raw('i18nComplete.textbeff1e4ca7a0')],
                  [Plug, 'Connectors', tI18nHardcoded.raw('i18nComplete.text7f8252af886d')],
                  [KeyRound, 'Secrets', tI18nHardcoded.raw('i18nComplete.textd2acf4ac763b')],
                  [MessagesSquare, 'Channels', tI18nHardcoded.raw('i18nComplete.text4a1ca4f91111')],
                  [Clock, 'Triggers', tI18nHardcoded.raw('i18nComplete.text276e88f0f37e')],
                  [Brain, 'Memory', tI18nHardcoded.raw('i18nComplete.textf354ef2ee567')],
                ] as [Glyph, string, string][]
              ).map(([Icon, k, v]) => ({
                id: k,
                k: (
                  <span className="flex items-center gap-3">
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {k}
                  </span>
                ),
                v,
              }))}
            />
            <Shot
              src={`${SHOT}/01-command-center.png`}
              alt={tI18nHardcoded.raw('i18nComplete.text0cc8e13decfa')}
              className="lg:col-span-7"
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
          title={tI18nHardcoded.raw('i18nComplete.text279b44d2ab4b')}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadMarkdownPersonasWith298b95be',
          )}
          facts={[
            tI18nHardcoded.raw('i18nComplete.text1c41f3a0be11'),
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
          title={tI18nHardcoded.raw('i18nComplete.text66d0f523a379')}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadThePartThat99be6c94',
          )}
          facts={[
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
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleConnectEverythingOnce90dc9225',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLead1ClickConnectbd49b095',
          )}
          facts={[
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
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextOneTokenNotNinetya67633e0',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextKeysOAuthAndModel44974f3c',
          )}
        >
          <div className="flex flex-col gap-6">
            <Cells className="lg:grid-cols-2">
              <Cell>
                <span className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-base line-through">
                  {[
                    tI18nHardcoded.raw('i18nComplete.text9c05aa57c149'),
                    tI18nHardcoded.raw('i18nComplete.text7ad1511cc614'),
                    tI18nHardcoded.raw('i18nComplete.text5872277e15ce'),
                    tI18nHardcoded.raw('i18nComplete.textee9c0bf3dfee'),
                    tI18nHardcoded.raw('i18nComplete.text98dd14248eba'),
                    tI18nHardcoded.raw('i18nComplete.text8128f44ac0d3'),
                  ].map((k) => (
                    <span key={k}>{k}</span>
                  ))}
                </span>
              </Cell>
              <Cell
                title={
                  <Mono className="text-2xl">
                    {tI18nHardcoded.raw(
                      'autoAppPresentationSlidesPlatformJsxText1KORTIXTOKEN7cd8465b',
                    )}
                  </Mono>
                }
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxTextSandboxScopedAudited1023f72c',
                )}
              </Cell>
            </Cells>
            <Cells className="lg:grid-cols-3">
              <Cell title={tI18nHardcoded.raw('i18nComplete.text5ebe32e1b916')} />
              <Cell title={tI18nHardcoded.raw('i18nComplete.text2fea30b8d515')} />
              <Cell title={tI18nHardcoded.raw('i18nComplete.text5731d8c0fb14')} />
            </Cells>
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
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleWhereYourPeople5a92eefb',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadSlackTeamsTelegram3e7973c3',
          )}
          facts={[
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
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleItRunsWithout0222686a',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadCronAndSignedc7137017',
          )}
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Code
              title={tI18nHardcoded.raw('i18nComplete.text1965f383021e')}
              className="lg:col-span-5"
              lines={[
                tI18nHardcoded.raw('i18nComplete.text609079a06653'),
                'triggers:',
                tI18nHardcoded.raw('i18nComplete.textdceafd500b4c'),
              ]}
            />
            <Cells className="lg:col-span-7 lg:grid-cols-2">
              <IconCell icon={Clock} title={tI18nHardcoded.raw('i18nComplete.textdd9d24965dbe')}>
                {tI18nHardcoded.raw('i18nComplete.textcfee87726b0a')}
              </IconCell>
              <IconCell icon={Webhook} title={tI18nHardcoded.raw('i18nComplete.text4814f62c108d')}>
                {tI18nHardcoded.raw('i18nComplete.text4f1601d68eb4')}
              </IconCell>
            </Cells>
          </div>
        </Slide>
      ),
    },

    /* 16 — CHANGE REQUESTS */
    {
      id: 'changes',
      label: tI18nHardcoded.raw('i18nComplete.text91f850fa869b'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleChangeRequests6e5aad55',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadTheReviewedMerge785e3799',
          )}
        >
          <Cells className="lg:grid-cols-3">
            <IconCell icon={Users} title={tI18nHardcoded.raw('i18nComplete.text9a1ffabd3658')} />
            <IconCell
              icon={GitBranch}
              title={tI18nHardcoded.raw('i18nComplete.text6d6fb78e4419')}
            />
            <IconCell
              icon={FileCode2}
              title={tI18nHardcoded.raw('i18nComplete.textb88cae951498')}
            />
          </Cells>
        </Slide>
      ),
    },

    /* 17 — MEMORY */
    {
      id: 'memory',
      label: tI18nHardcoded.raw('i18nComplete.textc3963aedaac6'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextALivingCompanyBrain7ed9d8a3',
          )}
          sub={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextFilesForNowAndf51cbec0')}
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Code
              title={tI18nHardcoded.raw('i18nComplete.text2ea11daa7745')}
              className="lg:col-span-6"
              lines={[
                '---',
                tI18nHardcoded.raw('i18nComplete.text821fc05f30c8'),
                tI18nHardcoded.raw('i18nComplete.text5667e2fe3cb5'),
                tI18nHardcoded.raw('i18nComplete.text96f660c6ea36'),
                '---',
                ' ',
                tI18nHardcoded.raw('i18nComplete.text40223a3c6277'),
                tI18nHardcoded.raw('i18nComplete.text742ae8324623'),
              ]}
            />
            <Cells className="lg:col-span-6 lg:grid-rows-3">
              <Cell title={tI18nHardcoded.raw('i18nComplete.text90cc8430dca3')} />
              <Cell title={tI18nHardcoded.raw('i18nComplete.text844d1616ac93')} />
              <Cell title={tI18nHardcoded.raw('i18nComplete.textea94f48d89d0')} />
            </Cells>
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
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleAWorkforceYou8e9267ec',
          )}
          lead={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadARealAccountc271c3da',
          )}
          facts={[
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
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleThreeWaysThe38c4ef16',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextPoliciesDecideWhatRunsdea9e686',
          )}
        >
          <Cells className="lg:grid-cols-3">
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
            ].map(([title, lead, body], i) => (
              <Cell key={title} label={`0${i + 1}`} title={title}>
                <span className="text-foreground block font-medium">{lead}</span>
                {body}
              </Cell>
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* 20 — REAL DELIVERABLES */
    {
      id: 'deliverables',
      label: tI18nHardcoded.raw('i18nComplete.textbab76032fb5d'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleAgentsReturnFinished8d0f12c2',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadNotATranscript07b7fc10',
          )}
        >
          <div className="grid gap-6 lg:grid-cols-3">
            {[
              ['slides', 'Slides'],
              ['research', 'Research'],
              ['data', 'Data'],
            ].map(([f, label]) => (
              <figure key={f} className="flex flex-col gap-3">
                <Shot src={`${DELIV}/${f}.png`} alt={label} />
                <figcaption className="text-muted-foreground text-sm">{label}</figcaption>
              </figure>
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
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleStartWithOne2fe53fe5',
          )}
          sub={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadEachIsA2eb95c3b')}
        >
          <Cells className="lg:grid-cols-3">
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
              <Cell key={tag} label={tag} title={title}>
                {body}
              </Cell>
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* 22 — TWO WAYS IN */
    {
      id: 'two-ways',
      label: tI18nHardcoded.raw('i18nComplete.text12cef29dfa4d'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleBuildersConfigureTeams883f9aee',
          )}
        >
          <Cells className="lg:grid-cols-2">
            <PillarCell
              icon={Code2}
              name={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextForBuildersc84efc99',
              )}
              line={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextConfigureItLikeSoftwaredfe3974f',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextDefineAgentsSkillsToolscf60a61c',
              )}
              facts={[
                tI18nHardcoded.raw('i18nComplete.textb78b4d8cdf7e'),
                tI18nHardcoded.raw('i18nComplete.texte65ac57c0c16'),
                tI18nHardcoded.raw('i18nComplete.textc92025bd3eeb'),
              ]}
            />
            <PillarCell
              icon={MessagesSquare}
              name={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextForTeams733bb9d9')}
              line={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextUseItLikeChat53e3e05e',
              )}
              body={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextGiveEveryTeamAgentsea166472',
              )}
              facts={[
                tI18nHardcoded.raw('i18nComplete.text602ff50f0ec1'),
                tI18nHardcoded.raw('i18nComplete.text88098ef371c2'),
                tI18nHardcoded.raw('i18nComplete.text4ee510d053d5'),
              ]}
            />
          </Cells>
        </Slide>
      ),
    },

    /* 23 — EVERY SURFACE */
    {
      id: 'surfaces',
      label: tI18nHardcoded.raw('i18nComplete.texteb7aa5b77168'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleChatSlackTeams59488d51',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadYourTeamTalkse4dd114d',
          )}
        >
          <Cells className="lg:grid-cols-3">
            {(
              [
                [Bot, tI18nHardcoded.raw('i18nComplete.texta535409d22df')],
                [Box, tI18nHardcoded.raw('i18nComplete.text429bbfa117e2')],
                [MessagesSquare, 'Slack'],
                [Users, tI18nHardcoded.raw('i18nComplete.texta7b52b269a23')],
                [Code2, tI18nHardcoded.raw('i18nComplete.texte27a31ed1d6f')],
                [Clock, tI18nHardcoded.raw('i18nComplete.text78f322ab2971')],
              ] as [Glyph, string][]
            ).map(([Icon, s]) => (
              <IconCell key={s} icon={Icon} title={s} />
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* 24 — FOR DEVELOPERS */
    {
      id: 'developers',
      label: tI18nHardcoded.raw('i18nComplete.text6f79cf5c144a'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleBuiltOnFiles64c977e2',
          )}
          sub={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadNoSDKToca0b7d2f')}
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Code
              title={tI18nHardcoded.raw('i18nComplete.text6f37eb69ebc8')}
              className="lg:col-span-5"
              lines={[
                '---',
                tI18nHardcoded.raw('i18nComplete.text5346918b32c0'),
                tI18nHardcoded.raw('i18nComplete.text035549be9e10'),
                '---',
                ' ',
                tI18nHardcoded.raw('i18nComplete.text9c84074599b5'),
                tI18nHardcoded.raw('i18nComplete.text4a01fea7c629'),
                tI18nHardcoded.raw('i18nComplete.text14f1b7cb49a1'),
              ]}
            />
            <Cells className="lg:col-span-7 lg:grid-cols-2">
              <IconCell
                icon={Boxes}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleAgentsAreSandboxes6c23b7e5',
                )}
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyEachRunsIn8ed57783',
                )}
              </IconCell>
              <IconCell
                icon={FileCode2}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleWorkIsCodecab734a3',
                )}
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyAgentsSkillsTriggerse8dad872',
                )}
              </IconCell>
              <IconCell
                icon={GitBranch}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleKortixInitShip24f086f1',
                )}
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyScaffoldAProject47c3905e',
                )}
              </IconCell>
              <IconCell
                icon={Server}
                title={tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrTitleYouOwnThe34e7b932',
                )}
              >
                {tI18nHardcoded.raw(
                  'autoAppPresentationSlidesPlatformJsxAttrBodyOpenAndSource3344f24a',
                )}
              </IconCell>
            </Cells>
          </div>
        </Slide>
      ),
    },

    /* 25 — SELF-HOST */
    {
      id: 'self-host',
      label: tI18nHardcoded.raw('i18nComplete.text37a5d04181b5'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleSameProductEverywhere41c9494d',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadRunKortixOn048c2e1e',
          )}
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Code
              title={tI18nHardcoded.raw('i18nComplete.text7859cc3ee2ae')}
              className="lg:col-span-6"
              lines={[
                `$ ${tI18nHardcoded.raw('i18nComplete.textdbef6cc84fef')}`,
                `$ ${tI18nHardcoded.raw('i18nComplete.text299438afe0c2')}`,
                tI18nHardcoded.raw('i18nComplete.texted9f27637609'),
              ]}
            />
            <Cells className="lg:col-span-6 lg:grid-cols-2">
              {(
                [
                  [Server, tI18nHardcoded.raw('i18nComplete.textf513ed1619ec')],
                  [Building2, tI18nHardcoded.raw('i18nComplete.text63a9ae000680')],
                  [Box, 'On-prem'],
                  [Shield, tI18nHardcoded.raw('i18nComplete.text1b00fe7ae5e3')],
                ] as [Glyph, string][]
              ).map(([Icon, h]) => (
                <IconCell key={h} icon={Icon} title={h} />
              ))}
            </Cells>
          </div>
        </Slide>
      ),
    },

    /* 26 — ENTERPRISE & SECURITY */
    {
      id: 'enterprise',
      label: tI18nHardcoded.raw('i18nComplete.text6bcb11c1c5d8'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleTheArchitectureIs4fc258b0',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrLeadBuiltToSurvive7727b9f7',
          )}
        >
          <Cells className="lg:grid-cols-4">
            <IconCell
              icon={Shield}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleHardIsolationd585df5c',
              )}
            >
              {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrBody1Session1d6ad1454')}
            </IconCell>
            <IconCell
              icon={KeyRound}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOneToken5d68cf6a',
              )}
            >
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyYourAPIKeyscd9e6087',
              )}
            </IconCell>
            <IconCell
              icon={GitBranch}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleAuditEverything3be9d076',
              )}
            >
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyEveryModelCall8c86019e',
              )}
            </IconCell>
            <IconCell
              icon={Building2}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOwnYourDatab56eaad9',
              )}
            >
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySelfHostVPC21d0cda0',
              )}
            </IconCell>
          </Cells>
          <Facts
            className="mt-8 flex-wrap gap-x-8 gap-y-3"
            items={[
              tI18nHardcoded.raw('i18nComplete.text188fba3516ee'),
              tI18nHardcoded.raw('i18nComplete.text60f41540d80e'),
              tI18nHardcoded.raw('i18nComplete.textf23e2655e76b'),
              tI18nHardcoded.raw('i18nComplete.text228d1d7e87d4'),
              tI18nHardcoded.raw('i18nComplete.textf982a576e7c6'),
              tI18nHardcoded.raw('i18nComplete.text2c4de2851235'),
              tI18nHardcoded.raw('i18nComplete.text0f8c0eb8cc5e'),
            ]}
          />
        </Slide>
      ),
    },

    /* 27 — WHO IT'S FOR */
    {
      id: 'audiences',
      label: tI18nHardcoded.raw('i18nComplete.text60c3907ec269'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleOnePlatformFour98163905',
          )}
        >
          <Cells className="lg:grid-cols-2">
            {(
              [
                [Code2, 'Developers', tI18nHardcoded.raw('i18nComplete.text1b17b7fdd191')],
                [Users, 'Companies', tI18nHardcoded.raw('i18nComplete.text82203da566c7')],
                [Shield, 'Enterprise', tI18nHardcoded.raw('i18nComplete.text777e112466d3')],
                [
                  Building2,
                  tI18nHardcoded.raw('i18nComplete.text827f9d2d8e74'),
                  tI18nHardcoded.raw('i18nComplete.texta21221a2eef4'),
                ],
              ] as [Glyph, string, string][]
            ).map(([Icon, title, body]) => (
              <IconCell key={title} icon={Icon} title={title}>
                {body}
              </IconCell>
            ))}
          </Cells>
        </Slide>
      ),
    },

    /* 28 — THE BUSINESS */
    {
      id: 'business',
      label: tI18nHardcoded.raw('i18nComplete.text507e19ce6f1b'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxAttrTitleThePlatformIsfa2254a2',
          )}
          sub={tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxAttrLeadWeBuildOur3a652ae7')}
        >
          <Cells className="lg:grid-cols-5">
            <IconCell
              icon={Code2}
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrTitleOpenSourced5df9dc2',
              )}
            >
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySelfHostableUnderneathb975d6f7',
              )}
            </IconCell>
            <IconCell icon={Layers} title={tI18nHardcoded.raw('i18nComplete.textb977b950c1ae')}>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodySeatsCompute61f703c9',
              )}
            </IconCell>
            <IconCell icon={Shield} title={tI18nHardcoded.raw('i18nComplete.textf5828f35ad93')}>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyRunItAnywhere9c8c4cd2',
              )}
            </IconCell>
            <IconCell icon={Store} title={tI18nHardcoded.raw('i18nComplete.textc608981d8d68')}>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyAgentsSkillsWholedd8eefbc',
              )}
            </IconCell>
            <IconCell icon={Boxes} title={tI18nHardcoded.raw('i18nComplete.textfb791d3beeee')}>
              {tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxAttrBodyTheComputeFloora3af4e83',
              )}
            </IconCell>
          </Cells>
          <BandNote>
            {tI18nHardcoded.raw('autoAppPresentationSlidesPlatformJsxTextTheLabsArePaid7834c27f')}
          </BandNote>
        </Slide>
      ),
    },

    /* 29 — CLOSING */
    {
      id: 'closing',
      label: tI18nHardcoded.raw('i18nComplete.textf79ebae4aae3'),
      node: (
        <Slide
          title={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextWeReBuildingTheda31c271',
          )}
          titleMuted={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextAndLetsItKeep69d7479b',
          )}
          sub={tI18nHardcoded.raw(
            'autoAppPresentationSlidesPlatformJsxTextOpenSourceSSORBAC8718a667',
          )}
        >
          <Cells className="lg:grid-cols-2">
            <Cell
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextStartBuildinge2f47368',
              )}
            >
              <Code title={SHELL} lines={[`$ ${KORTIX_CLI_INSTALL_COMMAND}`]} />
            </Cell>
            <Cell
              title={tI18nHardcoded.raw(
                'autoAppPresentationSlidesPlatformJsxTextTalkToSales159e3ec0',
              )}
            >
              <Mono className="text-foreground text-base">
                {tI18nHardcoded.raw('i18nComplete.text97eb27bdb657')}
              </Mono>
            </Cell>
          </Cells>
        </Slide>
      ),
    },
  ];
}
