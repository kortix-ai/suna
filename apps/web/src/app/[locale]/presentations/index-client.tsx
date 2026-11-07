'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * `/presentations`: every deck, in the landing page's frame. The 1440px
 * column between two rails, the hero's two-tone title, then one band of
 * hairline cells, one cell per deck. No eyebrow, no reveal motion.
 *
 * Slide and build counts are read from the decks themselves rather than typed
 * into the registry, so a cell can never drift from the deck it describes. The
 * minute estimate is deliberately coarse (≈20s per build step): it answers "do
 * I have time to run this before the call", nothing finer.
 */

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { countBuilds, localizedDecks, type DeckDef } from './registry';

/** Seconds of narration a single build step is worth, for the length estimate. */
const SECONDS_PER_BUILD = 20;

function DeckCell({ deck }: { deck: DeckDef }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const slides = deck.useSlides();
  const builds = countBuilds(slides);
  const minutes = Math.max(1, Math.round((builds * SECONDS_PER_BUILD) / 60));

  return (
    <Link
      href={`/presentations/${deck.slug}`}
      className="bg-background hover:bg-card outline-ring group flex flex-col gap-3 p-6 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 lg:p-8"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm">{deck.kind}</span>
        <ArrowUpRightIcon
          aria-hidden
          className="text-muted-foreground group-hover:text-foreground size-4 transition-colors"
        />
      </div>
      <h2 className="text-foreground text-lg font-medium tracking-tight">{deck.title}</h2>
      <p className="text-muted-foreground flex-1 text-sm text-pretty">{deck.description}</p>
      <p className="text-muted-foreground pt-3 text-sm tabular-nums">
        {slides.length} {tI18nComplete.raw('textfd2c8f1dc03c')} · {builds}{' '}
        {tI18nComplete.raw('text8459419d4cfe')} · ≈{minutes} {tI18nComplete.raw('text1f6fa6f69d18')}
      </p>
    </Link>
  );
}

export function PresentationsIndex() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const decks = localizedDecks(tI18nComplete);
  return (
    <div className="bg-background text-foreground h-full w-full overflow-y-auto">
      <main className="relative mx-auto min-h-full w-full max-w-[1440px]">
        <div
          aria-hidden
          className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17"
        />
        <div
          aria-hidden
          className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17"
        />

        <div className="flex h-16 items-center justify-between px-4 lg:px-24">
          <Link
            href="/"
            className="text-foreground outline-ring flex h-16 items-center rounded-sm focus-visible:outline-2"
          >
            <KortixLogo size={15} variant="logomark" />
          </Link>
          <ThemeToggle />
        </div>

        {/* The landing hero's type: two-tone title, one sentence. */}
        <div className="flex flex-col gap-5 px-8 pt-20 pb-16 lg:px-28 lg:pt-28">
          <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl lg:text-5xl">
            {tI18nComplete.raw('textcf31f39501ec')}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg">
            {tI18nComplete.raw('text8fc09bfec5dd')}{' '}
            <span className="text-foreground font-mono">F</span>{' '}
            {tI18nComplete.raw('text1bffac0197ca')}{' '}
            <span className="text-foreground font-mono">N</span>{' '}
            {tI18nComplete.raw('text584dabe853a5')}
          </p>
        </div>

        <div className="kx-rail-fade border-y px-4 lg:px-17">
          <div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
            {decks.map((deck) => (
              <DeckCell key={deck.slug} deck={deck} />
            ))}
            {/* Fill the last row, so the hairline grid never shows a bare
                border-coloured block: 2 columns from `sm`, 3 from `lg`. */}
            {Array.from({ length: (3 - (decks.length % 3)) % 3 }, (_, i) => (
              <div key={`lg-${i}`} aria-hidden className="bg-background hidden lg:block" />
            ))}
            {Array.from({ length: (2 - (decks.length % 2)) % 2 }, (_, i) => (
              <div key={`sm-${i}`} aria-hidden className="bg-background hidden sm:block lg:hidden" />
            ))}
          </div>
        </div>

        <p className="text-muted-foreground px-8 pt-8 pb-24 text-sm lg:px-28">
          {tI18nComplete.raw('text68af88a17bcb')}{' '}
          <span className="text-foreground font-mono">{tI18nComplete.raw('text2cf3f78e80d0')}</span>
          {tI18nComplete.raw('text4d1f460178d9')}{' '}
          <span className="text-foreground font-mono">{tI18nComplete.raw('text58f42611a053')}</span>.
        </p>
      </main>
    </div>
  );
}
