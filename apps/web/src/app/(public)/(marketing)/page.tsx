'use client';

import { FaqSection } from '@/features/marketing/faq';
import Hero from '@/features/marketing/hero';
import { HowItWorks } from '@/features/marketing/how-it-work/how-it-works';
import { CtaSection } from '@/features/marketing/landing/cta-section';
import { LogoStrip } from '@/features/marketing/landing/logo-strip';
import { ScrollCtaPill } from '@/features/marketing/landing/scroll-cta-pill';
import { TrustSection } from '@/features/marketing/landing/trust-section';
import { UseCaseWheel } from '@/features/marketing/landing/use-case-wheel';
import { OpenSourceSection } from '@/features/marketing/open-source/open-source-section';

/**
 * The arc, in the order a reader needs it: what it is, what it is made of, what
 * it does for a team, that it is genuinely yours, that it survives a security
 * review — then start.
 *
 * The prose used to be one long block. It is now four passages, each placed
 * against the section that raises the question it answers, so the page
 * alternates between something to look at and something to read instead of
 * asking for one long stretch of attention in the middle.
 *
 * There are no rules between sections. Each section already owns its own
 * vertical rhythm, so a hairline every time only drew attention to the seams
 * instead of the content on either side of them.
 */
export default function Home() {
  return (
    <div className="bg-background relative">
      {/* 1 · What it is — and the product actually running */}
      <Hero />

      {/* transition: the models it runs and the tools it connects */}
      <LogoStrip />

      {/* Past the hero its buttons are gone, so the pill takes over */}
      <div id="cta-pill-anchor" aria-hidden className="h-px" />

      {/* 2 · What it is made of — one card per layer, stacking as you descend,
             opening on the repo that holds all of them */}
      <HowItWorks />

      {/* 3 · What it does — real work, and the artefact it produces */}
      <UseCaseWheel />

      {/* Then why any of it is trustworthy in the first place: it is open,
          and the reason it is open. One centred note between the mechanism
          and the badges. */}
      <OpenSourceSection />

      {/* 4 · Where we stand on certification */}
      <TrustSection />

      {/* The questions a reader of this page still has, answered before the
          ask rather than after it */}
      <FaqSection />

      {/* Close, standing on its own */}
      <CtaSection />

      <ScrollCtaPill />
    </div>
  );
}
