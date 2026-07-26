'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { finalCta } from '@/features/landing/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

/**
 * Closing CTA — carried over from the current marketing homepage, including the
 * KortixGrid panel. Copy is the existing "Run your whole company from one repo
 * you own." block.
 */
export function LandingFinalCta() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleStart = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
        <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
          <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
            <div className="space-y-2">
              <Badge variant="kortix" className="rounded">
                {finalCta.badge}
              </Badge>
              <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                {finalCta.title}
              </h2>
              <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{finalCta.body}</p>
            </div>

            <p className="text-muted-foreground text-xs tracking-wider">{finalCta.fineprint}</p>

            <div className="mt-auto grid w-full grid-cols-1 gap-2">
              <Button size="lg" className="w-full" onClick={handleStart}>
                {finalCta.primaryCta}
                <HiArrowRight className="size-4" />
              </Button>
              <Button size="lg" className="w-full" variant="accent" onClick={() => openDemo()}>
                {finalCta.secondaryCta}
              </Button>
            </div>
          </div>
          <div className="col-span-1 hidden md:block" />
          <div className="col-span-7 mask-y-from-90% mask-x-from-90%">
            <KortixGrid count={58} seed={4228} />
          </div>
        </div>
      </div>
    </section>
  );
}
