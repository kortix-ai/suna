'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { hero } from '@/features/landing/content';
import { HeroStage } from '@/features/landing/hero-stage';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

/**
 * Hero — left-aligned and set on the Kortix letter field, matching the current
 * homepage. The centered variant this replaced read generic; the brand's
 * confidence comes from the flush-left display type over the character texture.
 */
export function LandingHero() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleStart = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="hero" className="relative overflow-hidden px-6 pt-32 pb-16 sm:pt-36 sm:pb-24">
      <div
        className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%"
        aria-hidden="true"
        data-a11y-decorative
      >
        <KortixLetterField seed={3382} />
      </div>
      <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      <div className="relative z-20 mx-auto w-full max-w-6xl">
        <Badge variant="kortix" className="rounded">
          {hero.eyebrow}
        </Badge>

        <h1 className="text-foreground mt-6 text-5xl font-medium tracking-tight text-balance sm:text-6xl lg:text-7xl">
          {hero.title}
        </h1>

        <p className="text-muted-foreground mt-5 text-2xl font-normal tracking-tight text-balance sm:text-3xl">
          {hero.tagline}
        </p>

        <p className="text-muted-foreground mt-6 max-w-xl text-base leading-relaxed">
          {hero.subtitle}
        </p>

        <div className="mt-9 flex flex-wrap gap-3">
          <Button size="xl" onClick={handleStart}>
            {hero.primaryCta}
            <HiArrowRight className="size-4" />
          </Button>
          <Button size="xl" variant="secondary" onClick={() => openDemo()}>
            {hero.secondaryCta}
          </Button>
        </div>

        <p className="text-muted-foreground/80 mt-6 text-xs tracking-wider">{hero.fineprint}</p>
      </div>
    </section>
  );
}

/**
 * The flow carousel is a sibling of the hero rather than a child of it.
 *
 * The hero needs `overflow-hidden` so the letter field and wallpaper can bleed
 * past its edges — but `overflow: hidden` on any ancestor silently kills
 * `position: sticky` on a descendant, which is what pins the stage while you
 * scroll it. They cannot live in the same element.
 */
export function LandingFlow() {
  return (
    <section className="px-6 pb-16 sm:pb-24">
      <HeroStage className="mx-auto max-w-6xl" />
    </section>
  );
}
