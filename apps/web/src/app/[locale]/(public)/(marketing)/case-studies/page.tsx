'use client';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';

import { CaseStudyGrid } from '@/features/marketing/case-studies/case-studies';
import { caseStudies as sourcecaseStudies } from '@/features/marketing/case-studies/content';
import { PageFrame, PageHero } from '@/features/marketing/kit/page-frame';

/**
 * `/case-studies`: every case study as one grid, the same cards as the home
 * page's row. Copy and the naming rules: `features/marketing/case-studies/content.ts`.
 */
export default function CaseStudiesPage() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { caseStudies } = localizeUiCatalog(
    { caseStudies: sourcecaseStudies },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

  return (
    <PageFrame>
      <PageHero
        title={caseStudies.title}
        titleMuted={caseStudies.titleMuted}
        sub="Research institutes, cloud companies, a telecom company, a hedge fund desk and Kortix itself, run on Kortix agents."
      />
      {/* Room before the footer's dither band, like every other page's last section. */}
      <div className="pb-20 lg:pb-28">
        <CaseStudyGrid />
      </div>
    </PageFrame>
  );
}
