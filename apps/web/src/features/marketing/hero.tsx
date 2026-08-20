'use client';

import { Button } from '@/components/ui/marketing/button';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Claude } from '@/features/icon/icons/claude';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { hero, heroEyebrow } from '@/features/marketing/landing/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { type ReactNode, useCallback } from 'react';

/** `heroEyebrow.rivals[].icon` selects a logo by name at runtime, so it can't be
 *  statically resolved to a single import — this explicit map is the smallest set
 *  that covers it, kept in sync by hand with `landing/content.ts`. */
const RIVAL_ICONS = { Claude, OpenAI } as const;

/** Anchors the product against the two things a reader already knows, with
 *  their marks. It used to sit ABOVE the H1, which made a competitor comparison
 *  the first thing on the page; it now renders as a proof line under the sub —
 *  the headline states what Kortix is, the sub defines it, and this backs it. */
function RivalProof() {
  return (
    <div className="kx-hero-text text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
      <span>{heroEyebrow.lead}</span>
      {heroEyebrow.rivals.map((r, i) => {
        const Glyph = RIVAL_ICONS[r.icon] as ((p: { className?: string }) => ReactNode) | undefined;
        return (
          <span key={r.id} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground/50 mr-1">and</span>}
            {Glyph ? <Glyph className="size-4" /> : null}
            <span className="text-foreground font-medium">{r.label}</span>
          </span>
        );
      })}
    </div>
  );
}

const Hero = () => {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? latestProjectPath(user?.id) : '/auth';
  }, [user]);

  /* The measure and the gutter belong on the same element, which is the rule the
     navbar already follows (`mx-auto w-full max-w-7xl px-6`). Splitting them —
     px-6 on the section, max-w-7xl on the inner containers — puts the padding
     outside the centred box instead of inside it, so once the viewport is wider
     than max-w-7xl the hero content starts 24px left of the navbar's and the H1
     hangs off the logo. Below max-w-7xl the two happen to agree, which is why it
     only shows on desktop. Every max-w-7xl container below therefore carries its
     own px-6. */
  return (
    /* The hero owns a full viewport and centres inside it. Before this it was
       simply padded from the top, so on a tall display the block finished with
       ~300px of dead space under it while the headline still sat ~30px below the
       navbar — top-heavy and cramped at the same time. `min-h-svh` plus
       `justify-center` splits the slack above and below instead, and the top
       padding is the floor that keeps the headline clear of the fixed navbar
       (67px) at every height. */
    <section
      id="hero"
      className="relative flex min-h-svh flex-col justify-center overflow-hidden pt-32 pb-12 sm:pt-36 sm:pb-16 lg:pt-32 lg:pb-14"
    >
      <div
        className="kx-hero-veil inset-0 z-0 hidden mask-t-from-70% lg:absolute"
        aria-hidden
        data-a11y-decorative
      >
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      {/* Six bands enter in reading order — proof → headline → sub → actions →
          product → trust — each with its own delay and its own distance. The
          whole fold settles by ~1.1s: the frame starts last but runs longest,
          so it lands with the trust line rather than after it.

          Delays are Tailwind arbitrary properties, not inline styles. Both the
          keyframes and the reduced-motion fallback live in globals.css, and an
          inline `animation-delay` would outrank the stylesheet and keep the
          staged reveal alive after prefers-reduced-motion removed the travel.
          Setting only `--kx-enter` leaves the stylesheet free to zero it. */}
      <div className="relative z-20">
        {/* The headline opens the page — nothing above it. At lg it steps up to
            6xl so it carries the fold the way the navbar carries the chrome. */}
        <div className="mx-auto w-full max-w-7xl px-6">
          {/* <RivalProof /> */}
          <h1 className="kx-hero-text text-foreground max-w-3xl text-4xl font-medium tracking-tight text-balance [--kx-enter:70ms] sm:text-5xl">
            {hero.title}
          </h1>
        </div>

        {/* sub + proof on the left, actions on the right — keeps the fold short */}
        <div className="mx-auto mt-6 w-full max-w-7xl px-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <p className="kx-hero-text text-muted-foreground text-base leading-relaxed text-pretty [--kx-enter:150ms] sm:text-lg">
                {hero.sub}
              </p>
            </div>

            <div className="kx-hero-text flex w-full shrink-0 flex-wrap gap-3 [--kx-enter:210ms] sm:w-auto">
              <Button
                size="lg"
                onClick={handleLaunch}
                className="flex-1 active:scale-[0.97] sm:flex-none"
              >
                {hero.ctaPrimary}
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => openDemo()}
                className="flex-1 active:scale-[0.97] sm:flex-none"
              >
                {hero.ctaSecondary}
              </Button>
            </div>
          </div>
        </div>

        <div
          id="demo"
          className="kx-hero-frame relative z-10 mx-auto mt-10 max-w-7xl scroll-mt-24 px-6 [--kx-enter:290ms] sm:mt-12 lg:mt-8"
        >
          <HeroSurfaces />
        </div>
      </div>
    </section>
  );
};

export default Hero;
