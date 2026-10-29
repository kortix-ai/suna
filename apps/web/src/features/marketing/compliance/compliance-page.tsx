import Link from '@/components/site-link';
import { PageColumn, Pillars, TrustBand } from '@/features/marketing/enterprise/sections';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';

import {
  BuildingsIcon,
  CloudIcon,
  CodeIcon,
  HandPalmIcon,
  HardDrivesIcon,
  IdentificationBadgeIcon,
  ListChecksIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { ComplianceHero } from './compliance-hero';
import { localizeMarketingContent as localizeContent } from './content';
import { ComplianceTopics } from './topic-panels';

/**
 * `/compliance`: the controls IT and compliance reviewers ask about, in the
 * home page's rhythm. Hero with one walkthrough of the admin view, four
 * pillars, one tab per topic, the trust band, then the FAQ. Copy and the
 * source of every line: `content.ts`. Isolation and secrets live on
 * /security; rollout, hosting and the contract live on /enterprise.
 */
export function CompliancePage(): ReactNode {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems, pillars, trust } = localizeContent(tMarketing);

  return (
    <PageColumn>
      <ComplianceHero />
      <Pillars
        pillars={pillars}
        icons={{
          identity: IdentificationBadgeIcon,
          access: UsersThreeIcon,
          governance: HandPalmIcon,
          audit: ListChecksIcon,
        }}
      />
      <ComplianceTopics />
      <TrustBand
        trust={trust}
        icons={[CloudIcon, HardDrivesIcon, BuildingsIcon, CodeIcon]}
        actions={
          <>
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <Link href="/enterprise">{tMarketing('texte4a7222927a8')}</Link>
            </MarketingButton>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/security">{tMarketing('text185d1ba951b2')}</Link>
            </MarketingButton>
          </>
        }
      />
      <FaqSection
        title={tMarketing('text11a07d2830be')}
        titleMuted="From the code and the docs."
        items={faqItems}
      />
    </PageColumn>
  );
}
