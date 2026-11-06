'use client';

/**
 * The sales deck. The narrative follows the "Kortix pres ENG" sales talk:
 * origin → what it is → interface → shared project → connect / configure /
 * deploy → no model lock-in → Slack and Teams → use cases → thanks.
 *
 * Frame: engine/frame.tsx, the landing page at 16:9. Every slide is a
 * two-tone title, an optional sub line, and one band of cells or real
 * product screenshots. No eyebrow, no kicker, no motif.
 *
 * Claims hold to .agents/skills/kortix-brand/references/verbal/claims.md:
 *  1. The star count is the only Kortix metric on a slide: no user count,
 *     no funding amount, no price.
 *  2. "machine" is not the shared concept: the team shares one project
 *     (a git repo). Each session still gets its own sandbox.
 *  3. Work reaches main through a change request a person approves.
 *  4. Approval gates are off until you set them: a hold is "set Ask".
 *  5. Channels are Slack, Microsoft Teams and email. No mobile app is public.
 *  6. Models: Kortix-managed open-weight models, any provider with your own
 *     keys, or a ChatGPT plan.
 */

import { useTranslations } from '@/i18n/use-translations';
import {
  BriefcaseIcon as Briefcase,
  CpuIcon as Cpu,
  CubeIcon as Cube,
  DatabaseIcon as Database,
  PlugIcon as Plug,
  RocketIcon as Rocket,
  SlidersHorizontalIcon as SlidersHorizontal,
  StarIcon as Star,
  UserCircleIcon as UserRound,
  UsersIcon as Users,
  WalletIcon as Wallet,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import { Cell, Cells, Mono, Shot, Slide } from '../engine/frame';

const SHOT = '/images/landing-showcase/platform';

/* ── local parts ────────────────────────────────────────────────────────── */

/** A Phosphor glyph in a cell's label slot, in ink, as on the landing pillars. */
function Glyph({ icon: Icon }: { icon: typeof Plug }) {
  return <Icon className="text-foreground size-6" aria-hidden />;
}

/** One figure in a cell: a glyph, the value at title scale, a quiet label. */
function Stat({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Star;
  value: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="bg-background flex flex-col gap-3 p-6 lg:p-8">
      <Icon className="text-foreground size-6" aria-hidden />
      <p className="text-foreground text-4xl font-medium tracking-tight tabular-nums">{value}</p>
      <p className="text-muted-foreground text-sm">{label}</p>
    </div>
  );
}

/** A product screenshot with a one-line caption under it. */
function CaptionedShot({ src, caption }: { src: string; caption: string }) {
  return (
    <figure className="flex flex-col gap-3">
      <Shot src={src} alt={caption} />
      <figcaption className="text-foreground text-sm">{caption}</figcaption>
    </figure>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */

export function useSlides(): SlideDef[] {
  const t = useTranslations('hardcodedUi');

  return [
    /* 1 — cover ─────────────────────────────────────────────────────────── */
    {
      id: 'cover',
      label: t.raw('i18nComplete.textfa8d84566676'),
      node: (
        <Slide
          size="cover"
          title={t.raw('autoAppPresentationSlidesEngJsxTextTheAICommandCentera5f1f9b6')}
          titleMuted={t.raw('autoAppPresentationSlidesEngJsxTextForYourCompany25d27be8')}
          sub={t.raw('autoAppPresentationSlidesEngJsxTextOnePlaceToBuild6874ebc8')}
        />
      ),
    },

    /* 2 — origin ────────────────────────────────────────────────────────── */
    {
      id: 'origin',
      label: t.raw('i18nComplete.textd3e1c5f8a6e2'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleApril2025We5a8b8958')}
          sub={t.raw('i18nComplete.textc1c52c665c38')}
        >
          <Cells className="lg:grid-cols-2">
            <Stat
              icon={Star}
              value="20,000+"
              label={t.raw('autoAppPresentationSlidesEngJsxAttrLabelGitHubStars281bbe4f')}
            />
            <Stat
              icon={Cube}
              value="Microsoft"
              label={t.raw('autoAppPresentationSlidesEngJsxAttrLabelViaGitHubFund874e057f')}
            />
          </Cells>
        </Slide>
      ),
    },

    /* 3 — what is Kortix today ──────────────────────────────────────────── */
    {
      id: 'what',
      label: t.raw('i18nComplete.text72e8173b2408'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxTextSoWhatIsKortixf6e68e29')}
          titleMuted={t.raw('autoAppPresentationSlidesEngJsxTextTheAICommandCenteraa567525')}
          sub={t.raw('autoAppPresentationSlidesEngJsxTextACommandCenterFor5691f67e')}
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <Cells className="lg:col-span-5 lg:auto-rows-fr">
              {[
                t.raw('i18nComplete.text1ae67a503b12'),
                t.raw('i18nComplete.text3c21bb15ccc5'),
                t.raw('i18nComplete.text2069eac0aa93'),
              ].map((line: string, i) => (
                <Cell key={line} label={`0${i + 1}`}>
                  <span className="text-foreground text-base">{line}</span>
                </Cell>
              ))}
            </Cells>
            <Shot
              className="lg:col-span-7"
              src={`${SHOT}/01-command-center.png`}
              alt={t.raw('i18nComplete.text0cc8e13decfa')}
            />
          </div>
        </Slide>
      ),
    },

    /* 4 — platform interface overview ───────────────────────────────────── */
    {
      id: 'platform',
      label: t.raw('i18nComplete.text111ec5778725'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxAttrTitlePlatformInterfaceOverview68617c3b')}
        >
          <div className="grid gap-6 lg:grid-cols-3">
            {(
              [
                [t.raw('i18nComplete.textbfca5e70d80a'), `${SHOT}/01-command-center.png`],
                [t.raw('i18nComplete.texte898c82553c3'), `${SHOT}/02-team.png`],
                [t.raw('i18nComplete.text538b028ecabf'), `${SHOT}/05-agents.png`],
              ] as [string, string][]
            ).map(([caption, src]) => (
              <CaptionedShot key={src} src={src} caption={caption} />
            ))}
          </div>
        </Slide>
      ),
    },

    /* 5 — a shared project ──────────────────────────────────────────────── */
    {
      id: 'shared-machine',
      label: t.raw('i18nComplete.text99abc69b22cb'),
      node: (
        <Slide title={t.raw('i18nComplete.text66daad66f75b')}>
          <Cells className="lg:grid-cols-2">
            <Cell label={<Glyph icon={Database} />} title={t.raw('i18nComplete.text8ca791133c6d')}>
              {t.raw('i18nComplete.text6a51df046a79')}
            </Cell>
            <Cell
              label={<Glyph icon={Users} />}
              title={t.raw('autoAppPresentationSlidesEngJsxTextAnAgentForEvery428d6526')}
            >
              {t.raw('i18nComplete.textd074906e01a1')}
            </Cell>
          </Cells>
        </Slide>
      ),
    },

    /* 6 — connect · configure · deploy ──────────────────────────────────── */
    {
      id: 'how',
      label: t.raw('i18nComplete.text7de7224be293'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleConnectConfigureDeploy54b71922')}
        >
          <Cells className="lg:grid-cols-3">
            <Cell
              label={<Glyph icon={Plug} />}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleYouConnectCompany944f7b6f')}
            >
              {t.raw('i18nComplete.text607c90ee388d')}
            </Cell>
            <Cell
              label={<Glyph icon={SlidersHorizontal} />}
              title={t.raw('i18nComplete.textb6db4991386c')}
            >
              {t.raw('i18nComplete.text1281ed377600')}
            </Cell>
            <Cell label={<Glyph icon={Rocket} />} title={t.raw('i18nComplete.text0fe1fe119d54')}>
              {t.raw('i18nComplete.text1635d6285776')}
            </Cell>
          </Cells>
        </Slide>
      ),
    },

    /* 7 — no model lock-in ──────────────────────────────────────────────── */
    {
      id: 'models',
      label: t.raw('i18nComplete.text45faa0a369e4'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleNoModelLock5cbe3d84')}
          sub={t.raw('i18nComplete.textf55f5ed2618c')}
        >
          <Cells className="lg:grid-cols-3">
            <Cell
              label={t.raw('i18nComplete.textb332c3492d5e')}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitlePickYourProvider8452d8cd')}
            >
              {t.raw('autoAppPresentationSlidesEngJsxAttrBodyChooseTheProvider485f153b')}
            </Cell>
            <Cell
              label={t.raw('i18nComplete.text52f61ed0009a')}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleSwitchInReal9708c591')}
            >
              {t.raw('autoAppPresentationSlidesEngJsxAttrBodySwitchModelsIne5bdf218')}
            </Cell>
            <Cell
              label={t.raw('i18nComplete.textf0d66a79c138')}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleYourTokensOr58f6d79d')}
            >
              {t.raw('i18nComplete.texta0586ccc1420')}
            </Cell>
          </Cells>
          <p className="text-muted-foreground mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span>{t.raw('i18nComplete.textd75025a6a12f')}</span>
            {[
              'OpenAI',
              'Anthropic',
              'Google',
              t.raw('i18nComplete.textb13524d6225f'),
              'On-prem',
            ].map((p: string) => (
              <span key={p} className="text-foreground inline-flex items-center gap-1.5">
                <Cpu className="size-4" aria-hidden />
                {p}
              </span>
            ))}
          </p>
        </Slide>
      ),
    },

    /* 8 — where Kortix lives ────────────────────────────────────────────── */
    {
      id: 'lives',
      label: t.raw('i18nComplete.text64e8222cd578'),
      node: (
        <Slide
          title={t.raw('autoAppPresentationSlidesEngJsxTextWhereKortixLives366879fa')}
          titleMuted={t.raw('autoAppPresentationSlidesEngJsxTextInsideSlackAndMicrosoftf6088064')}
          sub={t.raw('i18nComplete.textf87fa8568900')}
        >
          <div className="grid items-start gap-6 lg:grid-cols-12">
            <Shot
              className="lg:col-span-8"
              src={`${SHOT}/06-channels.png`}
              alt={t.raw('i18nComplete.text4aea922cfd21')}
            />
            <Cells className="lg:col-span-4">
              {[
                t.raw('i18nComplete.textb27fb38ba323'),
                t.raw('autoAppPresentationSlidesEngJsxTextMicrosoftTeams5bea06db'),
                t.raw('i18nComplete.textd05148eb065d'),
              ].map((surface: string) => (
                <Cell key={surface} title={surface} />
              ))}
            </Cells>
          </div>
        </Slide>
      ),
    },

    /* 9 — use cases ─────────────────────────────────────────────────────── */
    {
      id: 'use-cases',
      label: t.raw('i18nComplete.textff27a991e855'),
      node: (
        <Slide
          title={t.raw('i18nComplete.texte8e5e7984e2b')}
          titleMuted={t.raw('i18nComplete.textabbf59c48564')}
          sub={t.raw('autoAppPresentationSlidesEngJsxAttrLeadEachAgentHasa063247e')}
        >
          <Cells className="lg:grid-cols-3">
            <Cell
              label={<Glyph icon={Briefcase} />}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleASalesAgentb126b58b')}
            >
              {t.raw('i18nComplete.text69e789d99dfa')}
            </Cell>
            <Cell
              label={<Glyph icon={Wallet} />}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleAFinanceAgentb10006e4')}
            >
              {t.raw('autoAppPresentationSlidesEngJsxAttrBodyReconcilesTransactionsFlags3fe87d2a')}
            </Cell>
            <Cell
              label={<Glyph icon={UserRound} />}
              title={t.raw('autoAppPresentationSlidesEngJsxAttrTitleAnHRAgentc69f4dae')}
            >
              {t.raw('autoAppPresentationSlidesEngJsxAttrBodyOnboardsNewHiresd9d535ee')}
            </Cell>
          </Cells>
        </Slide>
      ),
    },

    /* 10 — closing ──────────────────────────────────────────────────────── */
    {
      id: 'closing',
      label: t.raw('i18nComplete.text268bc1833e83'),
      node: (
        <Slide
          size="cover"
          title={t.raw('i18nComplete.textfdac955a2fcf')}
          titleMuted={t.raw('autoAppPresentationSlidesEngJsxTextGetInTouchf319cf34')}
          sub={
            <>
              {t.raw('autoAppPresentationSlidesEngJsxTextTextMeAt7199731f')}{' '}
              <Mono className="text-foreground">
                {t.raw('autoAppPresentationSlidesEngJsxTextDomKortixAi2c244da6')}
              </Mono>{' '}
              {t.raw('autoAppPresentationSlidesEngJsxTextOrOnLinkedIn13b1c035')}
              <Mono className="text-foreground mt-3 block">
                {t.raw('i18nComplete.text97eb27bdb657')}
              </Mono>
            </>
          }
        />
      ),
    },
  ];
}
