'use client';

import { Hero } from '@/features/marketing/v2/hero';
import { ClosingCta } from '@/features/marketing/v2/sections/closing-cta';
import { ConnectorsSection } from '@/features/marketing/v2/sections/connectors';
import { InfrastructureSection } from '@/features/marketing/v2/sections/infrastructure';
import { PlugsSection } from '@/features/marketing/v2/sections/plugs';
import { SecuritySection } from '@/features/marketing/v2/sections/security';
import { SelfHostSection } from '@/features/marketing/v2/sections/self-host';
import {
  ManyAgentsSection,
  NotPlatformSection,
  SandboxSection,
} from '@/features/marketing/v2/sections/split-sections';
import { StackSection } from '@/features/marketing/v2/sections/stack';

export default function MarketingV2Page() {
  return (
    <main className="bg-background">
      <Hero />
      <StackSection />
      <InfrastructureSection />
      <SelfHostSection />
      <ConnectorsSection />
      <NotPlatformSection />
      <SandboxSection />
      <ManyAgentsSection />
      <SecuritySection />
      <PlugsSection />
      <ClosingCta />
    </main>
  );
}
