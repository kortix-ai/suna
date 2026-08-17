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
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
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
        className="inset-0 z-0 hidden mask-t-from-70% lg:absolute"
        aria-hidden
        data-a11y-decorative
      >
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      {/* kx-stagger fades each direct child up in turn (0/40/80/120ms):
          headline → sub + CTAs → product frame → trust line. The delays and the
          reduced-motion fallback both live in globals.css, so nothing here may
          set an inline animation-delay — an inline style would outrank the
          stylesheet and survive prefers-reduced-motion. */}
      <div className="kx-stagger relative z-20">
        {/* The headline opens the page — nothing above it. At lg it steps up to
            6xl so it carries the fold the way the navbar carries the chrome. */}
        <div className="mx-auto w-full max-w-7xl px-6">
          <RivalProof />
          <h1 className="text-foreground max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {hero.title}
          </h1>
        </div>

        {/* sub + proof on the left, actions on the right — keeps the fold short */}
        <div className="mx-auto mt-6 w-full max-w-7xl px-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <p className="text-muted-foreground text-base leading-relaxed text-pretty sm:text-lg">
                {hero.sub}
              </p>
            </div>

            {/* Primary leads. The two CTAs split the full width on a phone and
                shrink to their labels from sm up. Left at their intrinsic width
                they came to 139 and 123 of the 346 available, which is both a
                small target and an odd ragged pair under a full-bleed headline.

                h-12 on phones only. This theme sets --spacing to 0.23rem, so the
                shared size="lg" resolves to 36.8px, under the 44px touch target
                every mobile platform asks for; h-12 is 44.2px. The override is
                local because sm and up keeps the 36.8px the rest of the site is
                drawn to. */}
            <div className="flex w-full shrink-0 flex-wrap gap-3 sm:w-auto">
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
          className="relative z-10 mx-auto mt-10 max-w-7xl scroll-mt-24 px-6 sm:mt-12 lg:mt-8"
        >
          <HeroSurfaces />
        </div>

        <p className="text-muted-foreground/60 mx-auto mt-6 max-w-7xl px-6 text-center font-mono text-[11px] tracking-wide">
          {hero.trust}
        </p>
      </div>
    </section>
  );
};

export default Hero;
