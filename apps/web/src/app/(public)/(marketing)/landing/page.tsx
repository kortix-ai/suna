'use client';

import { LandingNav } from '@/features/landing/nav';
import { LandingFaq } from '@/features/landing/sections/faq';
import { LandingFinalCta } from '@/features/landing/sections/final-cta';
import { LandingFlow, LandingHero } from '@/features/landing/sections/hero';
import { LandingOpenSource } from '@/features/landing/sections/open-source';
import { LandingSecurity } from '@/features/landing/sections/security';
import { LandingUnderTheHood } from '@/features/landing/sections/under-the-hood';
import { LandingUseCases } from '@/features/landing/sections/use-cases';

/**
 * The rebuilt marketing landing page.
 *
 * Structured after chatgpt.com/work and claude.com/product/cowork: one claim per
 * section, generous whitespace, hairline rules instead of boxes, and a single
 * product surface carrying the hero. Complexity is back-loaded — the page opens
 * simple and only gets technical in "Under the hood", which hands off to
 * /technology.
 *
 * Intended to replace app/(public)/(marketing)/page.tsx once signed off.
 */
export default function LandingPage() {
  return (
    <main className="bg-background">
      <LandingNav />
      <LandingHero />
      <LandingFlow />
      <LandingUseCases />
      <LandingOpenSource />
      <LandingUnderTheHood />
      <LandingSecurity />
      <LandingFaq />
      <LandingFinalCta />
    </main>
  );
}
