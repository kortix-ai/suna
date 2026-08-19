/**
 * The deck registry — the one file you edit to add a presentation.
 *
 * A deck is a slug, some copy for the index card, and a `useSlides()` hook that
 * returns the slides. Everything else — the route, the index card, the metadata,
 * the keyboard engine, the presenter notes — is derived from this list.
 *
 * ── Adding a deck ────────────────────────────────────────────────────────
 *  1. Write `decks/<slug>.tsx` exporting `useSlides(): SlideDef[]`.
 *  2. Add a row below.
 * There is no step 3. See `README.md` in this directory for the slide API.
 *
 * `useSlides` is imported eagerly rather than lazily on purpose: the index page
 * counts slides and build steps to show a length estimate, so it needs every
 * deck's shape at render time. These are a few hundred lines of JSX each and
 * the whole route tree is `noindex`, internal, and behind no hot path.
 */

import { useSlides as usePlatformSlides } from './decks/platform';
import { useSlides as useSalesSlides } from './decks/sales';
import { useSlides as useSecuritySlides } from './decks/security';
import type { SlideDef } from './engine/deck';

export type DeckDef = {
  /** URL segment: /presentations/<slug>. Never change one that has been shared. */
  slug: string;
  title: string;
  /** One line on the index card, and the route's meta description. */
  description: string;
  /** Grouping on the index. Add a new one freely. */
  kind: 'Product' | 'Sales' | 'Internal';
  /** Shown as a chip. Say what a reader would otherwise have to ask. */
  tags?: readonly string[];
  useSlides: () => SlideDef[];
};

export const DECKS: readonly DeckDef[] = [
  {
    slug: 'security',
    title: 'Security walkthrough',
    description:
      'How Kortix contains an agent: one sandbox per session, connector keys the machine never holds, a human gate before anything reaches main, and a record of every action.',
    kind: 'Product',
    tags: ['Built to present', 'Diagram-led'],
    useSlides: useSecuritySlides,
  },
  {
    slug: 'platform',
    title: 'Product deck',
    description:
      'The in-depth platform walkthrough — the full Kortix surface, from projects and sessions to connectors, channels and change requests.',
    kind: 'Product',
    useSlides: usePlatformSlides,
  },
  {
    slug: 'sales',
    title: 'Sales deck',
    description:
      'The company narrative: where Kortix came from, what it is, and why a company runs on a repo and a workforce of agents.',
    kind: 'Sales',
    useSlides: useSalesSlides,
  },
] as const;

export function findDeck(slug: string): DeckDef | undefined {
  return DECKS.find((d) => d.slug === slug);
}

/** Total → presses in a deck: one per slide, plus each slide's build steps. */
export function countBuilds(slides: readonly SlideDef[]): number {
  return slides.reduce((n, s) => n + (s.steps ?? 0) + 1, 0);
}
