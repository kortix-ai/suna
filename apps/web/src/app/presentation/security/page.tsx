'use client';

/**
 * /presentation/security — the guided security walkthrough, built to be screen
 * recorded. Shares the deck engine; the spoken script lives on each slide and
 * is read from the presenter drawer (`N`), never rendered on the stage.
 */

import { Deck } from '../deck';
import { useSlides } from '../slides-security';

export default function SecurityPresentationPage() {
  const slides = useSlides();
  return <Deck slides={slides} altDeck={{ href: '/presentation/platform', label: 'Product deck' }} />;
}
