'use client';

/**
 * Resolves a slug to its deck and mounts the engine. Split out from `page.tsx`
 * so the route itself stays a server component and can export `metadata`.
 */

import { notFound } from 'next/navigation';
import { findDeck } from '../registry';
import { Deck } from '../engine/deck';

export function DeckClient({ slug }: { slug: string }) {
  const deck = findDeck(slug);
  if (!deck) notFound();
  // Registry order is fixed at module scope, so this hook is called
  // unconditionally for a given route — the slug cannot change without a
  // remount.
  const slides = deck.useSlides();
  return <Deck slides={slides} />;
}
