import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';

import { useTranslations } from '@/i18n/use-translations';

import {
  ArrowRightIcon,
  BrainIcon,
  BuildingsIcon,
  CloudIcon,
  CodeIcon,
  HardDrivesIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeContent } from './content';
import { EnterpriseHero } from './enterprise-hero';
import { PageColumn, Pillars, TrustBand } from './sections';
import { EnterpriseTopics } from './topic-panels';

/**
 * `/enterprise`: the buyer page for a company that runs Kortix across the
 * organization, in the home page's rhythm. Hero with one walkthrough of the
 * company view, four pillars, one tab per buyer topic, the trust band, then
 * the FAQ. Copy and the source of every line: `content.ts`. The controls IT
 * reviews live on /compliance; isolation and secrets on /security.
 */
export function EnterprisePage(): ReactNode {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { faqItems, pillars, trust } = localizeContent(tMarketing);

  return (
    <PageColumn>
      <EnterpriseHero />
      <Pillars
        pillars={pillars}
        icons={{
          platform: SquaresFourIcon,
          infra: HardDrivesIcon,
          models: BrainIcon,
          governed: ShieldCheckIcon,
        }}
        footer={{
          governed: (
            <Link
              href="/security"
              className="text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex items-center gap-1.5 self-start rounded-sm text-sm underline-offset-4 transition-colors ease-out hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {tMarketing('text43d612db102b')}
              <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          ),
        }}
      />
      <EnterpriseTopics />
      <TrustBand
        trust={trust}
        icons={[CloudIcon, HardDrivesIcon, BuildingsIcon, CodeIcon]}
        actions={
          <>
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <Link href="/compliance">{tMarketing('text4a109cc49467')}</Link>
            </MarketingButton>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/security">{tMarketing('text185d1ba951b2')}</Link>
            </MarketingButton>
          </>
        }
      />
      <FaqSection
        title={tMarketing('text8484a27f54b0')}
        titleMuted="From the code and the docs."
        items={faqItems}
      />
    </PageColumn>
  );
}
