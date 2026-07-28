'use client';

import { Hero } from '@/features/marketing/v2/hero';
import { AsCodeSection } from '@/features/marketing/v2/sections/as-code';
import { ChannelsSection } from '@/features/marketing/v2/sections/channels';
import { ClosingCta } from '@/features/marketing/v2/sections/closing-cta';
import { FlowSection } from '@/features/marketing/v2/sections/flow';
import { LibrarySection } from '@/features/marketing/v2/sections/library';
import { OpenSection } from '@/features/marketing/v2/sections/open';
import { SandboxSection } from '@/features/marketing/v2/sections/sandbox';
import { SecuritySection } from '@/features/marketing/v2/sections/security';
import { StackSection } from '@/features/marketing/v2/sections/stack';
import { WorkforceSection } from '@/features/marketing/v2/sections/workforce';

export default function MarketingV2Page() {
  return (
    <main className="bg-background">
      {/* 1. the command center */}
      <Hero />
      {/* 2. one computer, eight layers deep */}
      <StackSection />
      {/* 3. your whole company, as files */}
      <AsCodeSection />
      {/* 4. from a sentence to a reviewed merge */}
      <FlowSection />
      {/* 5. start work where your team already is */}
      <ChannelsSection />
      {/* 6. thousands of agents, one main branch */}
      <WorkforceSection />
      {/* 7. agents, skills, connectors */}
      <LibrarySection />
      {/* 8. every session gets a real computer */}
      <SandboxSection />
      {/* 9. built to survive a security review */}
      <SecuritySection />
      {/* 10. open, and yours */}
      <OpenSection />
      {/* 11. close */}
      <ClosingCta />
    </main>
  );
}
