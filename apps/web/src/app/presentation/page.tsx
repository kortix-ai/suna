'use client';

/**
 * /presentation — the Kortix sales deck (follows the official "Kortix pres ENG"
 * narrative). Shares the deck engine; links across to the full product deck.
 */

import { Deck } from './deck';
import { useSlides } from './slides-eng';

export default function PresentationPage() {
  const slides = useSlides();
  return (
    <Deck slides={slides} altDeck={{ href: '/presentation/platform', label: 'Product deck' }} />
  );
}
