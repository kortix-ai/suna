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

export default function Home() {
  return (
    <>
      <ModalProviders />
      <main className="flex flex-col items-center justify-center min-h-screen w-full">
        <div className="w-full divide-y divide-border">
          <HeroSection />
          <UseCasesSection />
          {/* <CompanyShowcase /> */}
          {/* <BentoSection /> */}
          {/* <QuoteSection /> */}
          {/* <FeatureSection /> */}
          {/* <GrowthSection /> */}
          <OpenSourceSection />
          <div className='flex flex-col items-center px-4'>
            <PricingSection />
          </div>
          <div className="mt-12 pb-12 mx-auto">
            <HeroVideoSection />
          </div>
          {/* <TestimonialSection /> */}
          {/* <FAQSection /> */}
          <CTASection />
          <FooterSection />
        </div>
      </main>
    </>
  );
}
