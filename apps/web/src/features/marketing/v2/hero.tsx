'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { HERO } from '@/features/marketing/v2/content';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { MAX_W } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

/**
 * The hero, matched to the live Kortix landing page rather than a colour field:
 * a white surface carrying the KortixLetterField texture, the badge eyebrow, the
 * two-line display headline, and the real `HeroSurfaces` switcher underneath.
 *
 * `HeroSurfaces` renders the actual product (web, Slack, Teams, mobile, CLI,
 * SDK) from live components, so it can never drift out of date the way a
 * committed screenshot does — the previous build's PNGs were two months stale.
 */
export function Hero() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleGetStarted = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="hero" className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
      <div
        className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%"
        aria-hidden
        data-a11y-decorative
      >
        <KortixLetterField seed={3382} />
      </div>
      <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      <div className="relative z-20">
        <div className={MAX_W}>
          <Badge variant="kortix" className="rounded">
            {HERO.eyebrow}
          </Badge>

          <h1 className="text-foreground mt-6 text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {HERO.headline.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </h1>

          <p className="text-muted-foreground mt-5 text-xl font-normal tracking-tight text-balance sm:text-2xl">
            {HERO.subline}
          </p>

          <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed">
            {HERO.description}
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" onClick={handleGetStarted}>
              {HERO.primaryCta}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="xl" variant="secondary" onClick={() => openDemo()}>
              {HERO.secondaryCta}
            </Button>
          </div>
        </div>

        {/* the live product, across every surface it runs on */}
        <div id="demo" className="relative z-10 mx-auto mt-14 max-w-6xl scroll-mt-24 sm:mt-20">
          <HeroSurfaces />
        </div>
      </div>
    </section>
  );
}
