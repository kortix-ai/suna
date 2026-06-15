'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import Link from 'next/link';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';
import { CLOSING } from './narrative';

export function ClosingCta() {
  const { user } = useAuth();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-sm border">
          <div className="grid grid-cols-1 md:grid-cols-12">
            <div className="flex flex-col items-start justify-center gap-5 p-8 sm:p-12 md:col-span-7">
              <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                {CLOSING.eyebrow}
              </p>
              <h2 className="text-foreground text-3xl leading-[1.1] font-medium tracking-tight sm:text-4xl md:text-5xl">
                {CLOSING.title[0]}
                <br />
                <span className="text-muted-foreground">{CLOSING.title[1]}</span>
              </h2>
              <p className="text-muted-foreground max-w-md text-base leading-relaxed">
                {CLOSING.description}
              </p>

              <div className="mt-2 flex flex-wrap gap-3">
                <Button size="xl" onClick={handleLaunch}>
                  {CLOSING.primaryCta}
                  <HiArrowRight className="size-4" />
                </Button>
                <Button size="xl" variant="secondary" asChild>
                  <Link href="/enterprise">{CLOSING.secondaryCta}</Link>
                </Button>
              </div>

              <p className="text-muted-foreground font-mono text-xs tracking-wider">
                {CLOSING.footnote}
              </p>
            </div>

            <div className="relative hidden md:col-span-5 md:block">
              <div className="absolute inset-0 mask-x-from-85% mask-y-from-85%">
                <KortixGrid count={48} seed={911} />
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
