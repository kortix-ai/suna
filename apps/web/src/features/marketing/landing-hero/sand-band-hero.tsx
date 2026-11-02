'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import {
  CodeIcon,
  GitForkIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { WorkspaceFramework } from './workspace-framework';

// What the CompanyOS is, beside the title (kortix-brand D35). Multiplayer,
// Extensible and Sovereign use the glyphs of their pillars below the hero.
const HERO_TRAITS = [
  { label: 'Open Source', icon: GitForkIcon },
  { label: 'Extensible', icon: CodeIcon },
  { label: 'Multiplayer', icon: UsersThreeIcon },
  { label: 'Sovereign', icon: ShieldCheckIcon },
];

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
        {/* The four traits as a quiet line above the title, then the title and
            one sentence on what it is. */}
        <div className="flex flex-col gap-4 lg:gap-5">
          <ul className="text-muted-foreground grid w-fit grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap sm:items-center sm:gap-x-5">
            {HERO_TRAITS.map(({ label, icon: Icon }) => (
              <li key={label} className="flex items-center gap-1.5 text-sm">
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </li>
            ))}
          </ul>
          <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl lg:text-[44px] lg:leading-13">
            The CompanyOS
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            The cloud-native agent harness for companies. Hand it an outcome and agents run it 24/7
            on your tools and context. Open source, in our cloud or yours.
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
