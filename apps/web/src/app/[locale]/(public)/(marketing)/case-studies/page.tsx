import { CaseStudyGrid } from '@/features/marketing/case-studies/case-studies';
import { caseStudies } from '@/features/marketing/case-studies/content';
import { PageFrame, PageHero } from '@/features/marketing/kit/page-frame';

/**
 * `/case-studies`: every case study as one grid, the same cards as the home
 * page's row. Copy and the naming rules: `features/marketing/case-studies/content.ts`.
 */
export default function CaseStudiesPage() {
  return (
    <PageFrame>
      <PageHero
        title={caseStudies.title}
        titleMuted={caseStudies.titleMuted}
        sub="Research institutes, cloud companies, a telecom company, a hedge fund desk and Kortix itself, run on Kortix agents."
      />
      <CaseStudyGrid />
    </PageFrame>
  );
}
