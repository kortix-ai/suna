'use client';

import { useEffect, useState } from 'react';
import { CTASection } from '@/components/home/sections/cta-section';
// import { FAQSection } from "@/components/sections/faq-section";
import { FooterSection } from '@/components/home/sections/footer-section';
import { HeroSection } from '@/components/home/sections/hero-section';
import { OpenSourceSection } from '@/components/home/sections/open-source-section';
import { PricingSection } from '@/components/home/sections/pricing-section';
import { UseCasesSection } from '@/components/home/sections/use-cases-section';
import { ModalProviders } from '@/providers/modal-providers';
import { HeroVideoSection } from '@/components/home/sections/hero-video-section';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { BentoSection } from '@/components/home/sections/bento-section';
import { CompanyShowcase } from '@/components/home/sections/company-showcase';
import { FeatureSection } from '@/components/home/sections/feature-section';
import { QuoteSection } from '@/components/home/sections/quote-section';
import { TestimonialSection } from '@/components/home/sections/testimonial-section';
import { FAQSection } from '@/components/home/sections/faq-section';
import { AgentShowcaseSection } from '@/components/home/sections/agent-showcase-section';
import { DeliverablesSection } from '@/components/home/sections/deliverables-section';
import { CapabilitiesSection } from '@/components/home/sections/capabilities-section';

export default function Home() {
  return (
    <>
      <ModalProviders />
      <BackgroundAALChecker>
        <main className="flex flex-col items-center justify-center min-h-screen w-full">
          <div className="w-full divide-y divide-border">
            <HeroSection />
            <CapabilitiesSection />
            {/* <DeliverablesSection />             */}
            <BentoSection />
            
            {/* <AgentShowcaseSection /> */}
            <OpenSourceSection />
            <PricingSection />
            {/* <TestimonialSection /> */}
            {/* <FAQSection /> */}
            <CTASection />
            <FooterSection />
          </div>
        </main>
      </BackgroundAALChecker>
    </>
  );
}
