import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';
import { PageColumn, Pillars, TrustBand } from '@/features/marketing/enterprise/sections';
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

import { faqItems, pillars, trust } from './content';
import { ComplianceHero } from './compliance-hero';
import { ComplianceTopics } from './topic-panels';

/**
 * `/compliance`: the controls IT and compliance reviewers ask about, in the
 * home page's rhythm. Hero with one walkthrough of the admin view, four
 * pillars, one tab per topic, the trust band, then the FAQ. Copy and the
 * source of every line: `content.ts`. Isolation and secrets live on
 * /security; rollout, hosting and the contract live on /enterprise.
 */
export function CompliancePage(): ReactNode {
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
              <Link href="/enterprise">Kortix for Enterprise</Link>
            </MarketingButton>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/security">Read the security page</Link>
            </MarketingButton>
          </>
        }
      />
      <FaqSection title="Compliance, answered." titleMuted="From the code and the docs." items={faqItems} />
    </PageColumn>
  );
}
