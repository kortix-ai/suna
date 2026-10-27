'use client';

import Link from '@/components/site-link';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import {
  controlsSummary,
  deploymentSummary,
  enterpriseSpecs,
  governanceSummary,
  isolationSummary,
} from '@/features/marketing/enterprise/summary';
import { splitTitle } from '@/features/marketing/kit/blocks';
import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { DitherGlyph } from '@/features/marketing/kit/dither-glyph';
import { ExchangeVisual } from '@/features/marketing/kit/exchange-visual';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, PageFrame, PageHero, SpecGrid } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { useTranslations } from '@/i18n/use-translations';
import { BuildingsIcon, CloudIcon, HardDrivesIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/**
 * `/enterprise`. The hero reads its strings from
 * `hardcodedUi.appHomeEnterprisePage`, so it stays translated. The sections
 * show the condensed English in `features/marketing/enterprise/summary.ts`.
 *
 * ACCURACY GATE (the security page's header has the sources):
 *  - Do NOT restore "never visible to the model" for secrets. Only CONNECTOR
 *    credentials never enter the machine. A runtime secret reaches a session
 *    through the starter's role intersected with the agent's grant.
 *  - Do NOT restore "scoped per person / per group" for secrets (retired by
 *    `20260706_secrets_v2_identifier_model.sql`).
 *  - Isolation is "its own isolated machine". "microVM" is only true on Platinum.
 *  - Approval gates are opt-in (`default_mode` falls back to `allow_all`), so
 *    write "an Ask rule pauses the call", never "risky calls pause by default".
 *  - SOC 2: Type I is verified; Type II is not mentioned (D17). No ISO, no HIPAA.
 *  - Dropped from the old page because nothing measures them: "rotated
 *    instantly", "audited forever", "full observability", "hundreds of
 *    teammates". ("Thousands of agents in parallel" is allowed by claims.md;
 *    it is simply not on this page.)
 *  - Scope the change-request rule to session work: dashboard config edits
 *    can commit straight to the default branch.
 *
 * Layout matches /security and /self-hosted: the landing page's frame,
 * `FeatureSplit` sections, split layouts where a visual earns it, dither art
 * in the hero. No closing section: the footer carries the call to action, and
 * the hero opens the demo modal.
 */

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-enterprise-demo';

export default function EnterprisePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = (key: string) => tHardcodedUi.raw(`appHomeEnterprisePage.${key}`) as string;
  const [calOpen, setCalOpen] = useState(false);
  const [heroTitle, heroTitleMuted] = splitTitle(t('heroTitle'));

  return (
    <>
      <PageFrame>
        <section id="hero">
          <PageHero
            title={heroTitle}
            titleMuted={heroTitleMuted}
            sub={t('heroDescription')}
            aside={<DitherGlyph src="/media/enterprise/buildings.svg" className="aspect-[15/13] w-80 xl:w-88" />}
            actions={
              <>
                <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
                  <Link href="/pricing">{t('comparePlansCta')}</Link>
                </MarketingButton>
                <MarketingButton size="md" className="hit-area-y-1" onClick={() => setCalOpen(true)}>
                  {t('talkToSalesCta')}
                </MarketingButton>
              </>
            }
          />
          <Band>
            <SpecGrid items={enterpriseSpecs} cols="lg:grid-cols-4" />
          </Band>
        </section>

        <FeatureSplit
          id="governance"
          {...governanceSummary}
          layout="split"
          visual={
            <ExchangeVisual
              cards={[
                {
                  mark: <BrandGlyph slug="stripe" />,
                  markPlain: true,
                  label: 'An Ask rule paused the call',
                  title: 'stripe.refunds.create',
                  detail: 'Waiting for a person to approve',
                  tag: 'ask',
                },
                {
                  mark: 'kortix',
                  title: 'Approved by an admin',
                  detail: 'Recorded in the audit log',
                  tag: 'logged',
                },
              ]}
            />
          }
        />

        <FeatureSplit id="isolation" {...isolationSummary} cols="lg:grid-cols-3" />

        <FeatureSplit
          id="controls"
          {...controlsSummary}
          cols="lg:grid-cols-5"
          after={
            <div className="grid grid-cols-1 items-center gap-10 px-8 pt-12 lg:grid-cols-12 lg:px-28">
              <div className="flex flex-col items-start gap-6 lg:col-span-5">
                <div>
                  <h3 className="text-foreground text-base font-medium">SOC 2 and GDPR</h3>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">
                    SOC 2 Type I verified. GDPR is a posture we run, with a DPA on Enterprise.
                  </p>
                </div>
                <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
                  <Link href="/security">Read the security page</Link>
                </MarketingButton>
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
          }
        />

        <FeatureSplit
          id="deployment"
          {...deploymentSummary}
          layout="split"
          visual={
            <ExchangeVisual
              cards={[
                {
                  mark: <CloudIcon className="size-4" />,
                  title: 'Managed cloud',
                  detail: 'We run it. You own the config and the data.',
                  tag: 'cloud',
                },
                {
                  mark: <HardDrivesIcon className="size-4" />,
                  title: 'Private VPC',
                  detail: 'The full platform in your own cloud account',
                  tag: 'vpc',
                },
                {
                  mark: <BuildingsIcon className="size-4" />,
                  title: 'On-prem',
                  detail: 'Your own network, scoped with us',
                  tag: 'on-prem',
                },
              ]}
            />
          }
        />
      </PageFrame>

      <DemoQualifierModal
        open={calOpen}
        onOpenChange={setCalOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="contact"
      />
    </>
  );
}
