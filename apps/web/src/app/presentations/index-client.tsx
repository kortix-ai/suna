'use client';

/**
 * `/presentations` — every internal deck, one card each.
 *
 * Slide and build counts are read from the decks themselves rather than typed
 * into the registry, so a card can never drift from the deck it describes. The
 * minute estimate is deliberately coarse (≈20s per build step) — it is there to
 * answer "do I have time to run this before the call", nothing finer.
 */

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { m } from 'motion/react';
import Link from 'next/link';
import { DECKS, countBuilds, type DeckDef } from './registry';

/** Seconds of narration a single build step is worth, for the length estimate. */
const SECONDS_PER_BUILD = 20;

function DeckCard({ deck, i }: { deck: DeckDef; i: number }) {
  const slides = deck.useSlides();
  const builds = countBuilds(slides);
  const minutes = Math.max(1, Math.round((builds * SECONDS_PER_BUILD) / 60));

  return (
    <m.div
      initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay: 0.06 * i, ease: [0.16, 1, 0.3, 1] }}
    >
      <Link
        href={`/presentations/${deck.slug}`}
        className="border-border bg-card hover:border-muted-foreground/40 group flex h-full flex-col rounded-sm border p-6 transition-colors sm:p-7"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {deck.kind}
          </span>
          <span className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors">
            ↗
          </span>
        </div>

        <h2 className="text-foreground mt-5 text-xl font-medium tracking-tight">{deck.title}</h2>
        <p className="text-muted-foreground mt-3 flex-1 text-sm leading-relaxed">
          {deck.description}
        </p>

        {deck.tags?.length ? (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {deck.tags.map((t) => (
              <Badge key={t} variant="outline" size="sm" className="rounded-sm font-normal">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}

        <dl className="border-border text-muted-foreground mt-6 flex items-center gap-5 border-t pt-4 font-mono text-[11px] tracking-wider tabular-nums">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground/50">slides</dt>
            <dd>{slides.length}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground/50">builds</dt>
            <dd>{builds}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground/50">≈</dt>
            <dd>{minutes} min</dd>
          </div>
        </dl>
      </Link>
    </m.div>
  );
}

export function PresentationsIndex() {
  return (
    <div className="bg-background text-foreground h-full w-full overflow-y-auto">
      <div className="pointer-events-none sticky top-0 z-10 flex items-center justify-between px-6 py-5 sm:px-8">
        <KortixLogo variant="logomark" size={22} className="text-foreground" />
        <div className="pointer-events-auto">
          <ThemeToggle />
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-6 pb-24">
        <m.div
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-2xl pt-12 pb-14 sm:pt-16"
        >
          <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            Internal
          </p>
          <h1 className="text-foreground mt-4 text-4xl font-medium tracking-tight sm:text-5xl">
            Presentations
          </h1>
          <p className="text-muted-foreground mt-5 text-base leading-relaxed">
            Every Kortix deck, built to be presented and screen recorded. Arrow keys drive it,{' '}
            <span className="text-foreground font-mono">F</span> goes fullscreen, and{' '}
            <span className="text-foreground font-mono">N</span> opens the spoken script without
            putting it on screen.
          </p>
        </m.div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DECKS.map((deck, i) => (
            <DeckCard key={deck.slug} deck={deck} i={i} />
          ))}
        </div>

        <p className="text-muted-foreground/60 mt-12 font-mono text-xs">
          Add one: write <span className="text-muted-foreground">decks/&lt;slug&gt;.tsx</span>, then
          add a row to <span className="text-muted-foreground">registry.ts</span>.
        </p>
      </div>
    </div>
  );
}
