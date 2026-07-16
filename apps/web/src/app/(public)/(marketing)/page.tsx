'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { Separator } from '@/components/ui/separator';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import {
  CompanyAsCodeSection,
  HowItRunsSection,
  ProblemSection,
} from '@/features/marketing/company-os-sections';
import Hero from '@/features/marketing/hero';
import { HowItWorks } from '@/features/marketing/how-it-work/how-it-works';
import Security from '@/features/marketing/security/security';
import WhyKortix from '@/features/marketing/why-kortix';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

function SectionDivider() {
  return (
    <div className="mx-auto max-w-6xl">
      <Separator />
    </div>
  );
}

export default function Home() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tHome = useCallback(
    (key: string) => tHardcodedUi.raw(`appHomePage.${key}`),
    [tHardcodedUi],
  );

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <>
      <div className="bg-background relative">
        {/* 1. Hero — the AI command center, every surface */}
        <Hero />

        <SectionDivider />

        {/* 2. Your whole company, as files — the interactive repo explorer */}
        <CompanyAsCodeSection />

        <SectionDivider />

        {/* 3. From a request to finished work — the how-it-works scroll */}
        <HowItWorks />

        <SectionDivider />

        {/* 4. A workforce, one shared main */}
        <HowItRunsSection />

        <SectionDivider />

        {/* 5. The 1% vs the 99% — shared with everyone */}
        <ProblemSection />

        <SectionDivider />

        {/* 6. Open & yours */}
        <WhyKortix />

        <SectionDivider />

        {/* 7. Enterprise & security */}
        <Security />

        <SectionDivider />

        {/* 8. CTA — run your whole company from one repo you own */}
        <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
              <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
                <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
                  <div className="space-y-2">
                    <Badge variant="kortix" className="rounded">
                      {tHome('ctaBadge')}
                    </Badge>
                    <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                      {tHome('line331JsxTextGiveYourCompanyAWorkforce')}
                    </h2>
                    <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
                      {tHome('line334JsxTextFreeToSelfHostManagedCloudFrom20')}
                    </p>
                  </div>

                  <p className="text-muted-foreground text-xs tracking-wider">
                    {tHome('line342JsxTextOpenSourceSSORBACOnPremNoLock')}
                  </p>

                  <div className="mt-auto grid w-full grid-cols-1 gap-2">
                    <Button size="lg" className="w-full" onClick={handleLaunch}>
                      {tHome('line337JsxTextGetStarted')}
                      <HiArrowRight className="size-4" />
                    </Button>
                    <Button size="lg" className="w-full" variant="accent" onClick={() => openDemo()}>
                      {tHome('line338JsxTextTalkToSales')}
                    </Button>
                  </div>
                </div>
                <div className="col-span-1 hidden md:block" />
                <div className="col-span-7 mask-y-from-90% mask-x-from-90%">
                  <KortixGrid count={58} seed={4228} />
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />
      </div>
    </>
  );
}
