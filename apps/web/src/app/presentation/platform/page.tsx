'use client';

/**
 * /presentation/platform — the full Kortix product deck (the in-depth platform
 * walkthrough). Shares the deck engine; links across to the sales deck.
 */

import { Deck } from '../deck';
import { SLIDES } from '../slides-platform';

export default function PlatformPresentationPage() {
  return <Deck slides={SLIDES} altDeck={{ href: '/presentation', label: 'Sales deck' }} />;
}
