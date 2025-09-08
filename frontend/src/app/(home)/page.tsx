'use client';

import { EnterpriseSecuritySection } from '@/components/home/sections/enterprise-security-section';
import { CompanyShowcase } from '@/components/home/sections/company-showcase';
import { CTASection } from '@/components/home/sections/cta-section';
import { EnterpriseSection } from '@/components/home/sections/enterprise-section';
import { FAQSection } from '@/components/home/sections/faq-section';
import { FeatureSection } from '@/components/home/sections/feature-section';
import { FooterSection } from '@/components/home/sections/footer-section';
import { HeroSection } from '@/components/home/sections/hero-section';
import { PricingSection } from '@/components/home/sections/pricing-section';
import { PlatformOverviewSection } from '@/components/home/sections/platform-overview-section';
import { UserTestimonialSection } from '@/components/home/sections/user-testimonial-section';
import { UseCasesSection } from '@/components/home/sections/use-cases-section';
import { ModalProviders } from '@/providers/modal-providers';
<<<<<<< HEAD
=======
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
>>>>>>> suna/PRODUCTION

export default function Home() {
  return (
    <>
      <ModalProviders />
<<<<<<< HEAD
      <main className="flex flex-col items-center justify-center min-h-screen w-full">
        <div className="w-full">
          <HeroSection />
          <PlatformOverviewSection />
          <CompanyShowcase />
          <UserTestimonialSection />
          <EnterpriseSecuritySection />
          <FeatureSection />
          <UseCasesSection />
          <EnterpriseSection />
          <PricingSection />
          <FAQSection />
          <CTASection />
          <FooterSection />
        </div>
      </main>
=======
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
>>>>>>> suna/PRODUCTION
    </>
  );
}
