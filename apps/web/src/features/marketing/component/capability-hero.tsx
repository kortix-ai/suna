'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { DitherShader } from '@/components/ui/wallpaper-shaders';
import { ArrowRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

type Props = {
  eyebrow: string;
  title: string;
  sub: string;
  ctaPrimary: string;
  ctaSecondary: string;
  ctaSecondaryHref: string;
  ctaPrimaryHref?: string;
  onCtaPrimaryClick?: () => void;
  /** The page's own hero scene. Every capability page ships one. */
  visual: ReactNode;
};

/**
 * Shared capability-page hero: full-viewport dither, copy and CTAs on the
 * left, and the page's own bespoke scene on the right. The shell is shared so
 * the pages stay consistent; the scene never is.
 */
export function CapabilityHero({
  eyebrow,
  title,
  sub,
  ctaPrimary,
  ctaPrimaryHref,
  onCtaPrimaryClick,
  ctaSecondary,
  ctaSecondaryHref,
  visual,
}: Props): ReactNode {
  const primaryButtonClass = 'flex-1 active:scale-[0.97] sm:flex-none';
  const primaryCta = onCtaPrimaryClick ? (
    <Button size="lg" className={primaryButtonClass} onClick={onCtaPrimaryClick}>
      {ctaPrimary}
    </Button>
  ) : (
    <Button size="lg" className={primaryButtonClass} asChild>
      <Link href={ctaPrimaryHref ?? '/auth'}>{ctaPrimary}</Link>
    </Button>
  );

  return (
    <section className="relative isolate flex min-h-[80dvh] w-full flex-row items-start justify-between overflow-visible border-b pt-32 pb-12 sm:pt-36 xl:h-[80dvh]">
      <div
        className="pointer-events-none absolute inset-0 z-0 origin-bottom mask-t-from-50% mask-t-to-80%"
        aria-hidden
      >
        <DitherShader />
      </div>

      <div className="relative mx-auto grid h-full w-full max-w-7xl grid-cols-1 place-items-center items-center gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <Reveal className="relative z-10 mx-auto flex aspect-auto w-full flex-col items-start justify-center gap-6 px-6 pt-6 pb-8 sm:px-8 sm:pt-8 sm:pb-16 xl:aspect-square">
          <span
            className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
            data-text="true"
          >
            {eyebrow}
          </span>
          <h1 className="text-foreground max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {title}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-lg leading-relaxed">{sub}</p>

          <div className="kx-hero-text flex w-full shrink-0 flex-wrap items-center gap-2 [--kx-enter:210ms] sm:w-auto sm:gap-3">
            {primaryCta}
            <Button
              size="lg"
              variant="ghost"
              className="group/cta flex-1 gap-1.5 active:scale-[0.97] sm:flex-none"
              asChild
            >
              <Link href={ctaSecondaryHref}>
                {ctaSecondary}
                <ArrowRightIcon
                  className="size-4 transition-transform duration-200 ease-out group-hover/cta:translate-x-0.5"
                  aria-hidden
                />
              </Link>
            </Button>
          </div>
        </Reveal>

        {/* <div className="relative z-20  -bottom-24 mx-auto flex w-full items-center justify-center px-6 xl:self-stretch"> */}
        <div className="relative z-20 mx-auto flex w-full items-center justify-center overflow-visible px-6 xl:self-stretch">
          {visual}
        </div>
      </div>
    </section>
  );
}
