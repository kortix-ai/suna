'use client';

/**
 * /presentation — the Kortix sales deck (follows the official "Kortix pres ENG"
 * narrative). Shares the deck engine; links across to the full product deck.
 */

import { Deck } from './deck';
import { SLIDES } from './slides-eng';

export default function PresentationPage() {
  return <Deck slides={SLIDES} altDeck={{ href: '/presentation/platform', label: 'Product deck' }} />;
}
