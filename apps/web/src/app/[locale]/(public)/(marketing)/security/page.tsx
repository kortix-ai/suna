import Link from '@/components/site-link';
import { DitherGlyph } from '@/features/marketing/kit/dither-glyph';
import { ExchangeVisual } from '@/features/marketing/kit/exchange-visual';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { ApprovalTabs } from '@/features/marketing/security-page/approval-tabs';
import { getLocalizedSecurityContent } from '@/features/marketing/security-page/content';
import {
  controlSummary,
  credentialsSummary,
  identitySummary,
  isolationSummary,
  landingSummary,
} from '@/features/marketing/security-page/summary';
import { useTranslations } from '@/i18n/use-translations';
import { KeyIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

/**
 * `/security`: the page a security reviewer reads before they let anyone else
 * in the building use Kortix.
 *
 * Every claim comes from `features/marketing/security-page/content.ts`, which
 * traces each one to code, including the seven places where a neighbouring
 * page or the `kortix-brand` skill says more than the code supports. The page
 * shows the condensed form in `summary.ts`; read the content header before
 * changing a fact in either file.
 *
 * Layout: the landing page's frame (`kit/page-frame.tsx`). Each section is a
 * `FeatureSplit`: the title on the left, one or two short paragraphs on the
 * right with the phrases that matter in ink, then one-line cells. Three
 * sections carry a still visual (`ExchangeVisual`) so the page is not only
 * text. Audit sits inside Identity. The disclosure section is left out until
 * the security inbox is confirmed (see `content.ts` → disclosure). The
 * closing call to action is the footer's.
 */

// The lines of kortix.yaml each approval note is about ([start, end) into
// control.yaml.lines). The whole file stays on screen; these stay bright.
const APPROVAL_FOCUS = {
  actions: [4, 19],
  conditions: [5, 11],
  percall: [6, 8],
  default: [0, 3],
} as const;

export default function SecurityPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { control, hero, posture } = getLocalizedSecurityContent(tI18nComplete);

  return (
    <PageFrame>
      {/* Hero, then the four facts the rest of the page proves. */}
      <section id="hero">
        <PageHero
          title={hero.title}
          titleMuted={hero.titleMuted}
          sub={hero.sub}
          aside={<DitherGlyph src="/media/security/lock.svg" className="aspect-[8/9] w-72 xl:w-80" />}
          actions={
            <>
              <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </MarketingButton>
              <MarketingButton size="md" className="hit-area-y-1" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </MarketingButton>
            </>
          }
        />
        <Band>
          <SpecGrid items={hero.specs} cols="lg:grid-cols-4" />
        </Band>
      </section>

      <FeatureSplit
        id="isolation"
        {...isolationSummary}
        layout="split"
        visual={
          <ExchangeVisual
            cards={[
              {
                mark: 'kortix',
                title: 'Weekly revenue report',
                detail: 'Its own machine · branch session/3f2a',
                tag: 'isolated',
              },
              {
                mark: 'kortix',
                title: 'Renewal emails',
                detail: 'Its own machine · branch session/91c7',
                tag: 'isolated',
              },
            ]}
          />
        }
      />

      <FeatureSplit
        id="credentials"
        {...credentialsSummary}
        cols="lg:grid-cols-5"
        visual={
          <ExchangeVisual
            cards={[
              {
                mark: <KeyIcon className="size-4" />,
                label: 'Granted to this session',
                title: 'STRIPE_API_KEY',
                detail: 'On tmpfs at mode 0600 · shredded on shutdown',
                tag: 'granted',
              },
              {
                mark: 'kortix',
                label: 'Held on the server',
                title: 'Slack connector',
                detail: 'The machine calls through one scoped Kortix token',
                tag: 'brokered',
              },
            ]}
          />
        }
      />

      <FeatureSplit id="identity" {...identitySummary} />

      {/* Approval: one line per rule on the left, the real kortix.yaml on the
          right with the selected rule's lines bright and the actions tinted. */}
      <Block id="control">
        <Heading title={controlSummary.title} titleMuted={controlSummary.titleMuted} sub={controlSummary.sub} />
        <Band className="mt-12">
          <ApprovalTabs
            notes={controlSummary.notes}
            title={control.yaml.title}
            lines={control.yaml.lines}
            slices={APPROVAL_FOCUS}
          />
        </Band>
      </Block>

      <FeatureSplit
        id="change-requests"
        {...landingSummary}
        layout="split"
        visual={
          <ExchangeVisual
            cards={[
              { label: 'You', title: 'Fix the onboarding docs and open a change request.' },
              {
                mark: 'kortix',
                title: 'Change request opened against main',
                detail: (
                  <>
                    docs/onboarding.md · <span className="text-kortix-green">+24</span>{' '}
                    <span className="text-kortix-red">−6</span> · merge needs a grant
                  </>
                ),
                tag: 'review',
              },
            ]}
          />
        }
      />

      {/* Posture: where it runs, and the honest compliance line. */}
      <Block id="posture">
        <Heading title={posture.title} titleMuted={posture.titleMuted} sub={posture.sub} />
        <Band className="mt-12">
          <CellGrid
            cols="lg:grid-cols-3"
            items={posture.deployments.map((item) => ({ id: item.id, k: item.k, v: item.v }))}
          />
        </Band>
        <div className="grid grid-cols-1 items-center gap-10 px-8 pt-12 lg:grid-cols-12 lg:px-28">
          <div className="lg:col-span-5">
            <h3 className="text-foreground text-base font-medium">{posture.compliance.label}</h3>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">{posture.compliance.note}</p>
          </div>
          <ul className="flex flex-wrap items-center gap-4 lg:col-span-7 lg:justify-end">
            <li>
              <Seal name="SOC 2" detail="Type I" note="Verified" ornament="double" />
            </li>
            <li>
              <Seal name="GDPR" detail="Operated" ornament="stars" />
            </li>
          </ul>
        </div>
      </Block>
    </PageFrame>
  );
}
