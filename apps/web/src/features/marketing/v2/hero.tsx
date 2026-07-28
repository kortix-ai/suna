'use client';

import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { AppPreview } from '@/features/marketing/v2/app-preview';
import { HERO, LOGOS } from '@/features/marketing/v2/content';
import { Eyebrow } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

export function Hero() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleGetStarted = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section className="bg-background relative isolate overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 -z-10 mask-y-to-90%"
        aria-hidden
        data-a11y-decorative
      >
        <KortixLetterField seed={3382} />
      </div>

      <div className="mx-auto max-w-6xl px-6 pt-32 sm:pt-40">
        <Eyebrow>{HERO.eyebrow}</Eyebrow>

        <h1 className="text-foreground mt-6 max-w-4xl text-4xl leading-[1.08] font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
          {HERO.headline.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>

        <div className="mt-10 flex flex-col gap-6 sm:mt-12 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-muted-foreground max-w-md text-base leading-relaxed">
            {HERO.subline}
          </p>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="lg" onClick={handleGetStarted}>
              {HERO.primaryCta}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="lg" variant="secondary" onClick={() => openDemo()}>
              {HERO.secondaryCta}
            </Button>
          </div>
        </div>

        {/* the product still, clipped by the fold */}
        <div className="relative mt-14 sm:mt-16">
          <div
            className="border-border rounded-t-lg border-x border-t p-1.5 pb-0"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in oklab, var(--kortix-blue) 11%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 5%, var(--background)) 100%)',
            }}
          >
            <div className="bg-background border-border h-[30rem] overflow-hidden rounded-t-md border-x border-t sm:h-[34rem]">
              <AppPreview />
            </div>
          </div>
          <div
            aria-hidden
            data-a11y-decorative
            className="from-background/0 to-background pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b"
          />
        </div>
      </div>

      <LogoWall />
    </section>
  );
}

function LogoWall() {
  return (
    <div className="border-border bg-background relative border-t">
      <div className="mx-auto max-w-6xl px-6 py-12 sm:py-14">
        <p className="text-muted-foreground text-center text-xs tracking-wider">
          {HERO.logoWallLabel}
        </p>
        <div className="mt-8 grid grid-cols-2 items-center gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          {LOGOS.map((name) => (
            <span
              key={name}
              className="text-muted-foreground/70 text-center text-sm font-semibold tracking-[0.12em] uppercase"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
