'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { Separator } from '@/components/ui/separator';
import { CompanyAsRepo } from '@/features/marketing/company-as-repo';
import Hero from '@/features/marketing/hero';
import { HowItWorks } from '@/features/marketing/how-it-work/how-it-works';
import { ModalitySwitcher } from '@/features/marketing/modality-switcher';
import { RuntimeArchitecture } from '@/features/marketing/runtime-architecture';
import Security from '@/features/marketing/security/security';
import { UseCasesByDepartment } from '@/features/marketing/use-cases-by-department';
import { WhyItsAHire } from '@/features/marketing/why-its-a-hire';
import WhyKortix from '@/features/marketing/why-kortix';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

export default function Home() {
  const { user } = useAuth();
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
        <Hero />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <UseCasesByDepartment />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <WhyItsAHire />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <CompanyAsRepo />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <RuntimeArchitecture />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <ModalitySwitcher />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <HowItWorks />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <WhyKortix />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

        <Security />

        <div className="mx-auto max-w-6xl">
          <Separator />
        </div>

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
                    <Button asChild size="lg" className="w-full" variant="accent">
                      <Link href={'/enterprise'}>{tHome('line338JsxTextTalkToSales')}</Link>
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
