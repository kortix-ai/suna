import { CaseStudies } from '@/features/marketing/case-studies/case-studies';
import { HowItWorksTabs } from '@/features/marketing/landing-sections/how-it-works-tabs';
import { TrustBand } from '@/features/marketing/landing-sections/trust-band';
import { UseCasesBand } from '@/features/marketing/landing-sections/use-cases-band';
import { WorksWithStrip } from '@/features/marketing/landing-sections/works-with-strip';
import { LandingFaqSection } from '@/features/marketing/landing-sections/faq-section';
import { PillarsBand } from '@/features/marketing/landing-sections/pillars-band';
import { ProblemSolution } from '@/features/marketing/landing-sections/problem-solution';
import { SandBandHero } from '@/features/marketing/landing-hero/sand-band-hero';

/**
 * The landing page is being rebuilt section by section from the Paper board
 * "Kortix 2". Every section sits inside one 1440px column between two hairline
 * rails; the closing call to action and the footer come from the marketing
 * shell.
 */
export default function Home() {
  return (
    <main className="bg-background relative mx-auto w-full max-w-[1440px]">
      {/* Rails: 62px in from each edge on the board. z-10 keeps them above the band fill. */}
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17" />
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17" />
      <SandBandHero />
      <WorksWithStrip />
      <CaseStudies />
      <ProblemSolution />
      <HowItWorksTabs />
      <PillarsBand />
      <UseCasesBand />
      <TrustBand />
      <LandingFaqSection />
    </main>
  );
}
