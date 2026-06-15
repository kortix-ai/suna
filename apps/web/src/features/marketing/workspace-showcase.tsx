'use client';

import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import { Reveal } from '@/components/home/reveal';

export function WorkspaceShowcase() {
  return (
    <section id="demo" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-10 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          See it in action
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          The whole workspace, live
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">
          Projects, chat, agents, skills, integrations, models — explore the actual product surface.
          Click around; it’s interactive.
        </p>
      </div>
      <Reveal>
        <InteractiveDemoSection />
      </Reveal>
    </section>
  );
}
