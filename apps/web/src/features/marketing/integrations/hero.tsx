'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { Github } from '@/features/icon/icons/github';
import { Gmail } from '@/features/icon/icons/gmail';
import { Linear } from '@/features/icon/icons/linear';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Notion } from '@/features/icon/icons/notion';
import { Slack } from '@/features/icon/icons/slack';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { hero } from './content';

/** `hero.logos` selects a logo by name at runtime, so it can't be statically
 *  resolved to a single import — this explicit map is the smallest set that
 *  covers it, kept in sync by hand with `./content.ts`. */
const LOGO_ICONS = { Slack, Notion, Linear, Github, Gmail, MicrosoftTeams } as const;

/**
 * The logo row. Brand marks only — every one of these is a connector that
 * exists in the product today. Never add a logo here to imply a customer.
 */
function LogoRow() {
  return (
    <ul className="mt-12 flex flex-wrap items-center gap-2.5">
      {hero.logos.map((key) => {
        const Glyph = LOGO_ICONS[key] as ((p: { className?: string }) => ReactNode) | undefined;
        if (!Glyph) return null;
        return (
          <li
            key={key}
            className="border-border bg-background flex size-11 items-center justify-center rounded-sm border"
          >
            <Glyph className="size-5" />
          </li>
        );
      })}
      <li className="border-border text-muted-foreground rounded-sm border px-3 py-3 font-mono text-[11px] leading-none">
        + 3,000 more
      </li>
    </ul>
  );
}

export function IntegrationsHero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-12 sm:pt-36">
      <div className="absolute inset-0 z-0 mask-y-to-95%">
        <KortixLetterField seed={7211} />
      </div>
      <div className="relative mx-auto max-w-7xl px-6">
        <Reveal>
          <Badge variant="kortix" className="rounded">
            {hero.eyebrow}
          </Badge>
          <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {hero.title}
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">{hero.sub}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">{hero.ctaPrimary}</Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
            {hero.microline}
          </p>
          <LogoRow />
        </Reveal>
      </div>
    </section>
  );
}
