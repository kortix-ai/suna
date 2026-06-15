'use client';

import { Reveal } from '@/components/home/reveal';
import { LogoMarqueeRows } from '@/components/home/logo-marquee';
import { EVERY_TOOL } from './narrative';

export function EveryTool() {
  return (
    <section className="overflow-hidden py-16 sm:py-24">
      <div className="mx-auto mb-12 max-w-2xl space-y-3 px-6 text-center lg:px-0">
        <Reveal>
          <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            {EVERY_TOOL.eyebrow}
          </p>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            {EVERY_TOOL.title}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-xl text-base leading-relaxed">
            {EVERY_TOOL.description}
          </p>
        </Reveal>
      </div>

      <Reveal delay={0.1}>
        <LogoMarqueeRows />
      </Reveal>

      <p className="text-muted-foreground mt-10 text-center font-mono text-xs tracking-wider">
        {EVERY_TOOL.footnote}
      </p>
    </section>
  );
}
