'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { WorkspaceFramework } from './workspace-framework';

// The three pillars and "open source", as ticks beside the title (kortix-brand D35).
const HERO_TICKS = ['Sovereign', 'Extensible', 'Multiplayer', 'Open source'];

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
        {/* Title and one plain sentence on the left; the four ticks on the
            right from lg up, and as a row under the sentence below lg. */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
          <div className="flex flex-col gap-4 lg:gap-5">
            <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl lg:text-[44px] lg:leading-13">
              The CompanyOS
            </h1>
            <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
              Hand it an outcome and AI agents run it 24/7. They work in your tools, next to your
              whole team, and everything they do is yours to keep, on your infrastructure or ours.
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 lg:flex-col lg:items-start lg:gap-y-2.5 lg:pb-1">
            {HERO_TICKS.map((tick) => (
              <li key={tick} className="text-foreground flex items-center gap-2 text-base lg:text-lg">
                <CheckIcon className="size-4 shrink-0 lg:size-5" weight="bold" aria-hidden />
                {tick}
              </li>
            ))}
          </ul>
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
        <div className="bg-card relative flex flex-col items-center gap-7 overflow-hidden px-4 py-7 lg:gap-10 lg:px-0 lg:pt-17 lg:pb-10">
          {/* The walkthrough keeps the hero's dev dimensions: max-w-304 wide,
              a 1264 × 860 board, in the same band padding. */}
          <div id="demo" className="relative w-full max-w-304 scroll-mt-24">
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
