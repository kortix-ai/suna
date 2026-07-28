'use client';

/**
 * The empty-state showcase: a mock composer that types out what Kortix can do,
 * sitting on a stack of session cards.
 *
 * It replaces the row of hardcoded starter chips that used to sit under the
 * composer. Those claimed to be suggestions for you and were the same six for
 * everybody; this makes no such claim — it demonstrates the product's range
 * instead of faking personalisation, which is the honest version of the same
 * screen real estate.
 */

import { ArrowUp, Mic, Search } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';

import { Icon } from '@/features/icon/icon';
import {
  INITIAL_TYPEWRITER,
  advanceTypewriter,
  phraseAt,
  visibleRest,
} from '@/lib/home/showcase-phrases';
import { cn } from '@/lib/utils';

/** One typing tick. Fast enough to feel alive, slow enough to read. */
const TICK_MS = 38;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface DelegateShowcaseProps {
  title: string;
  description: string;
  /** The single call to action under the copy. Omitted when there is nothing to ask for. */
  action?: React.ReactNode;
  className?: string;
}

export function DelegateShowcase({ title, description, action, className }: DelegateShowcaseProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [state, tick] = useReducer(
    (s: typeof INITIAL_TYPEWRITER) => advanceTypewriter(s),
    INITIAL_TYPEWRITER,
  );

  useEffect(() => {
    // Reduced motion gets the finished sentence, not a frozen empty box.
    if (reducedMotion) return;
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  const phrase = phraseAt(state);
  if (!phrase) return null;
  const PhraseIcon = phrase.icon;
  const typed = reducedMotion ? phrase.rest : visibleRest(state);
  const caretVisible = !reducedMotion && state.phase !== 'holding';

  return (
    <div className={cn('flex w-full flex-col items-center gap-6', className)}>
      {/* The card stack. The bars behind read as earlier sessions, which is
          what a Kortix project actually accumulates. */}
      {/* Opaque on purpose. Translucent fills let the dotted SessionWelcome
          backdrop bleed through the card and the stack behind it, which reads
          as a stray layer floating over the page rather than as a card. */}
      <div className="border-border/60 bg-muted/40 relative w-full max-w-lg overflow-hidden rounded-2xl border px-6 pt-10 pb-8 backdrop-blur-sm sm:px-10">
        <div className="relative mx-auto w-full max-w-sm">
          <div
            aria-hidden
            className="bg-background/60 border-border/50 absolute -top-5 right-6 left-6 h-8 rounded-t-xl border border-b-0"
          />
          <div
            aria-hidden
            className="bg-background/85 border-border/60 absolute -top-2.5 right-3 left-3 h-8 rounded-t-xl border border-b-0"
          />

          <div className="bg-background relative rounded-xl border p-3 shadow-sm">
            <p
              className="text-muted-foreground min-h-[3.25rem] text-sm leading-relaxed"
              aria-live="polite"
            >
              <span className="text-foreground font-medium">Kortix</span>{' '}
              <PhraseIcon
                className="text-foreground mr-0.5 inline size-3.5 -translate-y-px"
                aria-hidden
              />
              <span className="text-foreground font-medium">{phrase.verb}</span> {typed}
              {caretVisible ? (
                <span className="bg-foreground ml-0.5 inline-block h-3.5 w-px translate-y-0.5 motion-safe:animate-pulse" />
              ) : null}
            </p>

            {/* A mock toolbar — deliberately inert. It mirrors the real
                composer so the graphic reads as the product, not an
                illustration of it. */}
            <div className="mt-2 flex items-center gap-1.5" aria-hidden>
              <span className="text-muted-foreground inline-flex size-7 items-center justify-center rounded-full">
                <Search className="size-3.5" />
              </span>
              <span className="text-muted-foreground bg-muted/60 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium">
                <Icon.Kortix className="size-3.5" />
                Kortix
              </span>
              <span className="flex-1" />
              <span className="text-muted-foreground inline-flex size-7 items-center justify-center rounded-full">
                <Mic className="size-3.5" />
              </span>
              <span className="bg-muted-foreground/80 text-background inline-flex size-7 items-center justify-center rounded-full">
                <ArrowUp className="size-3.5" />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground max-w-md text-sm text-pretty">{description}</p>
      </div>

      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

export default DelegateShowcase;
