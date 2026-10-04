'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { PillLink } from '@/features/marketing/os/primitives';
import { cn } from '@/lib/utils';
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

const PILL = 'inline-flex h-11 items-center rounded-full px-5 text-base';

/**
 * Shared capability-page hero, AI OS style: a full-bleed dark art pane (Beams,
 * dark in both themes) with the mark, the eyebrow, a centred headline, the sub
 * and two pills. The page's own scene follows in the band below and overlaps
 * the pane's floor, so the first thing past the headline is the artifact.
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
  const primaryCta = onCtaPrimaryClick ? (
    <button
      type="button"
      onClick={onCtaPrimaryClick}
      className={cn(PILL, 'bg-foreground text-background hover:bg-foreground/90 transition-colors')}
    >
      {ctaPrimary}
    </button>
  ) : (
    <PillLink href={ctaPrimaryHref ?? '/auth'}>{ctaPrimary}</PillLink>
  );

  return (
    <>
      <section
        data-kx-dark-hero=""
        className="dark bg-background text-foreground relative isolate flex min-h-[80svh] items-center overflow-hidden px-6 pt-40 pb-48"
      >
        <div className="kx-hero-veil absolute inset-0 -z-10" aria-hidden>
          <BeamsShader />
          <div className="from-background/90 via-background/40 to-background absolute inset-0 bg-linear-to-b" />
        </div>
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 text-center">
          <span className="kx-hero-text text-muted-foreground flex items-center gap-2 text-lg">
            <KortixLogo size={16} />
            {eyebrow}
          </span>
          <h1 className="kx-hero-text text-foreground text-4xl font-normal tracking-tight text-balance [--kx-enter:80ms] sm:text-6xl">
            {title}
          </h1>
          <p className="kx-hero-text text-foreground/75 max-w-2xl text-lg leading-relaxed text-pretty [--kx-enter:160ms]">
            {sub}
          </p>
          <div className="kx-hero-text flex flex-wrap justify-center gap-3 [--kx-enter:240ms]">
            {primaryCta}
            <PillLink tone="outline" href={ctaSecondaryHref}>
              {ctaSecondary}
            </PillLink>
          </div>
        </div>
      </section>

      <div className="kx-hero-frame relative z-10 mx-auto -mt-32 flex w-full max-w-5xl justify-center px-6 pb-12 [--kx-enter:320ms]">
        {visual}
      </div>
    </>
  );
}
