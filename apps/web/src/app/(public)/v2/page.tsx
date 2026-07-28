'use client';

import { Hero } from '@/features/marketing/v2/hero';
import { ClosingCta } from '@/features/marketing/v2/sections/closing-cta';
import { ConnectorsSection } from '@/features/marketing/v2/sections/connectors';
import { InfrastructureSection } from '@/features/marketing/v2/sections/infrastructure';
import { PlugsSection } from '@/features/marketing/v2/sections/plugs';
import { SecuritySection } from '@/features/marketing/v2/sections/security';
import { SelfHostSection } from '@/features/marketing/v2/sections/self-host';
import {
  AsCodeSection,
  NotPlatformSection,
  SandboxSection,
  WorkforceSection,
} from '@/features/marketing/v2/sections/splits';
import { StackSection } from '@/features/marketing/v2/sections/stack';

export default function MarketingV2Page() {
  return (
    <main className="bg-background">
      {/* 1. hero + logo wall */}
      <Hero />
      {/* 2. the stack — scroll-pinned */}
      <StackSection />
      {/* 3. the infrastructure layer + step rail */}
      <InfrastructureSection />
      {/* 4. self-host panel */}
      <SelfHostSection />
      {/* 5. tag @Kortix where the work is happening */}
      <ConnectorsSection />
      {/* 6. agents shouldn't become your platform */}
      <NotPlatformSection />
      {/* 7. your whole company, as files */}
      <AsCodeSection />
      {/* 8. cloud environments for every session */}
      <SandboxSection />
      {/* 9. a workforce, not an assistant */}
      <WorkforceSection />
      {/* 10. the dark trust panel */}
      <SecuritySection />
      {/* 11. plugs into your stack — carousel */}
      <PlugsSection />
      {/* 12. close */}
      <ClosingCta />
    </main>
  );
}
