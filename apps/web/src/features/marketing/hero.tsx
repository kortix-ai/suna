'use client';

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
 *  their marks, so "AI Management System" lands without a paragraph first. */
function RivalEyebrow() {
  return (
    /* `justify-center` centres the wrapped rows as a unit; each rival stays its
       own inline `flex items-center` span, so the logo and its label never
       separate when the row wraps on a phone. */
    <div className="kx-hero-text text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-center text-sm">
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
       ~300px of dead space under it while the eyebrow still sat ~30px below the
       navbar — top-heavy and cramped at the same time. `min-h-svh` plus
       `justify-center` splits the slack above and below instead, and the top
       padding is the floor that keeps the eyebrow clear of the fixed navbar
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

      {/* Six bands enter in reading order — eyebrow → headline → sub → actions →
          product → trust — each with its own delay and its own distance. The
          whole fold settles at ~1.11s: the frame starts before the trust line
          but runs 820ms to its 620ms, so the two land together rather than the
          frame landing after.

          Delays are Tailwind arbitrary properties, not inline styles. Both the
          keyframes and the reduced-motion fallback live in globals.css, and an
          inline `animation-delay` would outrank the stylesheet and keep the
          staged reveal alive after prefers-reduced-motion removed the travel.
          Setting only `--kx-enter` leaves the stylesheet free to zero it. */}
      <div className="relative z-20">
        <div className="mx-auto w-full max-w-7xl px-6">
          <RivalEyebrow />

          {/* `mx-auto` on the measure is what actually centres the block: without
              it `max-w-3xl` stays flush left inside max-w-7xl and only the glyphs
              inside it centre, which leaves the headline off-axis on desktop. */}
          <h1 className="kx-hero-text text-foreground mx-auto mt-5 max-w-3xl text-center text-4xl font-medium tracking-tight text-balance [--kx-enter:70ms] sm:text-5xl">
            {hero.title}
          </h1>

          {/* One centred column under the headline. It was a left sub / right
              actions row while the hero owned CTAs; with those gone the row had
              nothing to justify against. */}
          <div className="mt-6 flex flex-col items-center gap-5">
            <p className="kx-hero-text text-muted-foreground mx-auto max-w-xl text-center text-base leading-relaxed text-pretty [--kx-enter:150ms] sm:text-lg">
              {hero.sub}
            </p>

            {/* The two CTAs split the full width on a phone and shrink to their
                labels from sm up. Left at their intrinsic width they came to 139
                and 123 of the 346 available, which is both a small target and an
                odd ragged pair under a full-bleed headline.

                h-12 on phones only. This theme sets --spacing to 0.23rem, so the
                shared size="lg" resolves to 36.8px, under the 44px touch target
                every mobile platform asks for; h-12 is 44.2px. The override is
                local because sm and up keeps the 36.8px the rest of the site is
                drawn to. */}
            {/* Hero CTAs (Request demo / Get started) hidden on request. The
                navbar still carries both at every scroll position, so the page
                keeps its calls to action.

                To restore: uncomment the block AND re-add the two imports it
                needs, which were dropped so the file stays lint-clean while it
                is dead —
                  import { Button } from '@/components/ui/marketing/button';
                  import { ArrowRightIcon } from '@phosphor-icons/react';
                `openDemo` and `handleLaunch` above are kept for the same
                restore, and are otherwise unused. The wrapper keeps its
                `kx-hero-text [--kx-enter:210ms]` band so restoring it puts the
                pair back in the staged reveal at its old slot, between the sub
                (150ms) and the frame (290ms). */}
            {/* <div className="kx-hero-text flex w-full shrink-0 flex-wrap gap-3 [--kx-enter:210ms] sm:w-auto">
              <Button
                size="lg"
                variant="secondary"
                onClick={() => openDemo()}
                className="h-12 flex-1 sm:h-10 sm:flex-none"
              >
                {hero.ctaSecondary}
              </Button>
              <Button size="lg" onClick={handleLaunch} className="h-12 flex-1 sm:h-10 sm:flex-none">
                {hero.ctaPrimary}
                <ArrowRightIcon className="size-4" />
              </Button>
            </div> */}
          </div>
        </div>

        <div
          id="demo"
          className="kx-hero-frame relative z-10 mx-auto mt-10 max-w-7xl scroll-mt-24 px-6 [--kx-enter:290ms] sm:mt-12 lg:mt-8"
        >
          <HeroSurfaces />
        </div>

        {/* 490ms + the 620ms text ramp lands this at 1110ms — the exact moment
            the frame (290ms + 820ms) finishes, so the fold closes on one beat. */}
        <p className="kx-hero-text text-muted-foreground/60 mx-auto mt-6 max-w-7xl px-6 text-center font-mono text-[11px] tracking-wide [--kx-enter:490ms]">
          {hero.trust}
        </p>
      </div>
    </section>
  );
};

export default Hero;
