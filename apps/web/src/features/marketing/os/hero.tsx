'use client';

import Link from '@/components/site-link';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { announcement, osHero } from './content';
import { DemoPill, PillLink } from './primitives';

/**
 * The fold. A full-bleed dark art pane (Beams, dark in both themes) carries the
 * headline bottom-left and the sub plus both actions bottom-right. The real
 * product (the surfaces player) follows directly under it, so the first thing
 * past the art is the artifact the reader can open.
 */
export function OsHero() {
  return (
    <>
      <section id="hero" className="dark relative flex min-h-svh flex-col overflow-hidden bg-background">
        <div className="kx-hero-veil absolute inset-0" aria-hidden>
          <BeamsShader />
          {/* Floor scrim: the copy sits on a calm band, never on a beam. */}
          <div className="from-background/90 absolute inset-x-0 bottom-0 h-2/3 bg-linear-to-t to-transparent" />
        </div>

        <div className="relative z-10 mx-auto mt-auto flex w-full max-w-7xl flex-col gap-10 px-6 pt-40 pb-16 lg:flex-row lg:items-end lg:justify-between lg:pb-20">
          <h1 className="kx-hero-text text-foreground max-w-3xl text-5xl font-normal tracking-tight text-balance sm:text-6xl lg:text-7xl">
            {osHero.title}
          </h1>
          <div className="flex max-w-md flex-col gap-6 lg:pb-2">
            <p className="kx-hero-text text-foreground/80 text-lg leading-relaxed text-pretty [--kx-enter:120ms]">
              {osHero.sub}
            </p>
            <div className="kx-hero-text flex flex-wrap gap-3 [--kx-enter:200ms]">
              <PillLink href={osHero.primary.href}>{osHero.primary.label}</PillLink>
              <DemoPill source="home-hero">{osHero.secondary.label}</DemoPill>
            </div>
          </div>
        </div>
      </section>

      <div id="demo" className="mx-auto w-full max-w-7xl scroll-mt-24 px-6 pt-16 md:pt-24">
        <HeroSurfaces />
      </div>
    </>
  );
}

/** One line above the navbar, like a release note pinned to the door. */
export function Announcement() {
  return (
    <Link
      href={announcement.href}
      className="bg-muted text-muted-foreground hover:text-foreground flex h-9 w-full items-center justify-center gap-2 px-6 text-xs transition-colors"
    >
      <span className="truncate">{announcement.label}</span>
      <span className="text-foreground hidden items-center gap-1 sm:flex">
        {announcement.cta}
        <ArrowRightIcon className="size-3.5" />
      </span>
    </Link>
  );
}
