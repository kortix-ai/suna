'use client';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import Link from 'next/link';

import { SessionWindow } from './session-window';


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
            <span className="text-foreground block">The open-source AI Operating System</span>
            <span className="text-muted-foreground block">for companies that own their agents</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            Agents, skills, memory and connectors live in one git repo you own. Any model, your
            keys, in our cloud or self-hosted.
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
        <div className="bg-card relative flex flex-col items-center gap-7 overflow-hidden px-4 py-7 lg:gap-10 lg:px-0 lg:pt-17 lg:pb-10">
          <div id="demo" className="relative w-full max-w-304 scroll-mt-24">
            <SessionWindow />
          </div>
          {/* Leads into the works-with strip directly below the band. */}
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            Runs any model, connects every tool.{' '}
            <span className="text-muted-foreground">Claude, GPT, Gemini and the apps you already use.</span>
          </p>
        </div>
      </div>
    </section>
  );
}
