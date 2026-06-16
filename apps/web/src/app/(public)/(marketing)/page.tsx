'use client';

import { Capabilities } from '@/features/marketing/capabilities';
import { ClosingCta } from '@/features/marketing/closing-cta';
import { Comparison } from '@/features/marketing/comparison';
import { EveryTool } from '@/features/marketing/every-tool';
import { Faq } from '@/features/marketing/faq';
import Hero from '@/features/marketing/hero';
import { Moat } from '@/features/marketing/moat';
import { Problem } from '@/features/marketing/problem';
import { RealOutput } from '@/features/marketing/real-output';
import Security from '@/features/marketing/security/security';
import { Skillify } from '@/features/marketing/skillify';
import { TrustStrip } from '@/features/marketing/trust-strip';
import { UseCases } from '@/features/marketing/use-cases';
import { HomeWalkthrough } from '@/features/marketing/walkthrough';
import { WorkspaceShowcase } from '@/features/marketing/workspace-showcase';
import { Separator } from '@/components/ui/separator';

function SectionDivider() {
  return (
    <div className="mx-auto max-w-6xl">
      <Separator />
    </div>
  );
}

export default function Home() {
  return (
    <div className="bg-background relative">
      <Hero />
      <TrustStrip />

      <SectionDivider />
      <HomeWalkthrough />

      <SectionDivider />
      <RealOutput />

      <EveryTool />

      <SectionDivider />
      <Skillify />

      <SectionDivider />
      <Capabilities />

      <SectionDivider />
      <Problem />

      <SectionDivider />
      <Comparison />

      <SectionDivider />
      <UseCases />

      <SectionDivider />
      <WorkspaceShowcase />

      <SectionDivider />
      <Moat />

      <SectionDivider />
      <Security />

      <SectionDivider />
      <Faq />

      <SectionDivider />
      <ClosingCta />

      <div className="h-24 sm:h-28" />
    </div>
  );
}
