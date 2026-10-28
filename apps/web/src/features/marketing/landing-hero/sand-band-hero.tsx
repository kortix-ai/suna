'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { WorkspaceFramework } from './workspace-framework';

// The hero's adjective cycles through the three pillars and "open" (kortix-brand D16, D21).
const PILLAR_WORDS = ['sovereign', 'multiplayer', 'extensible', 'open'];

/**
 * "The <word> AI Operating System", the word changing every 2.5 s. The new
 * word mounts and fades in (opacity only, so reduced motion needs no variant,
 * motion.md); the line reflows to its width. Screen readers get one static
 * sentence.
 */
function PillarWord() {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setShown((n) => (n + 1) % PILLAR_WORDS.length), 2500);
    return () => clearInterval(timer);
  }, []);
  const word = PILLAR_WORDS.at(shown);

  return (
    <span
      key={word}
      aria-hidden
      className="animate-in fade-in duration-slower whitespace-nowrap ease-out"
    >
      {word}
    </span>
  );
}

/**
 * Landing hero, Paper "Kortix 2" Hero D (Accrue layout): the two-tone
 * headline on white, then a band between the page's rails
 * that carries the live session window (HVM-0, `SessionWindow`).
 *
 * Paper → kit: ink #1f1f1f = foreground, surface-1 #f4f4f4 = card,
 * #fafafa = sidebar, #a6a6a6 = muted-foreground, 12/11px mono = text-xs.
 */
export function SandBandHero() {
  const openDemo = useRequestDemo();

  return (
    <section id="hero" className="relative">
      <div className="relative flex flex-col gap-7.5 px-8 pt-32 pb-18 lg:px-28 lg:pt-40">
        {/* Title, then one plain sentence on what it is (Devin's hero
            pattern): sits close under the title, muted, two lines at most. */}
        <div className="flex flex-col gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="sr-only">
              The sovereign, multiplayer, extensible and open AI Operating System
            </span>
            <span aria-hidden className="text-foreground block">
              The <PillarWord /> AI Operating System
            </span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            Hand it an outcome and agents run it 24/7. Multiplayer AI for your whole team, your
            company as code, sovereign and open source on your infrastructure or ours.
          </p>
        </div>

        <div className="flex flex-wrap gap-2.5 pt-2">
          <MarketingButton
            variant="secondary"
            size="md"
            className="hit-area-y-1"
            onClick={() => openDemo({ source: 'landing-hero' })}
          >
            Talk to sales
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href="/auth">Start for free</Link>
          </MarketingButton>
        </div>
      </div>

      {/* Band row: hairlines top and bottom across the page, a plain band
          between the rails. */}
      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="bg-card relative flex flex-col items-center gap-5 overflow-hidden px-3 py-5 sm:px-6 lg:gap-6 lg:px-8 lg:py-7">
          {/* The player (16:9 stage plus control bar) keeps the window width
              the hero has always had, max-w-304. */}
          <div id="demo" className="relative w-full max-w-304 scroll-mt-16">
            <WorkspaceFramework />
          </div>
          {/* What the two views show, in one line. */}
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            A workspace and command center for people. A backend framework for agents underneath.{' '}
            <span className="text-muted-foreground">
              The same project, as files in a git repo you own.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
