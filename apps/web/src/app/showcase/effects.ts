/**
 * Registry for the /showcase gallery — one entry per brand effect.
 *
 * This module is intentionally pure metadata (no component imports) so it stays
 * unit-testable and cheap to import from the server index page. The slug → React
 * component mapping lives in the detail route (`[slug]/page.tsx`), which is the
 * only place that pulls in the client/canvas/WebGL components.
 *
 * To add an effect: append an entry here and register its component in the
 * detail route's `EFFECT_COMPONENTS` map. Nothing else needs to change.
 */

export type ShowcaseLayout = 'framed' | 'fullscreen';

export type ShowcaseEffect = {
  /** URL segment: /showcase/<slug>. */
  slug: string;
  name: string;
  /** One-line hook shown on the gallery card. */
  tagline: string;
  /** Fuller sentence for the effect's own page header. */
  description: string;
  /** Interaction hint shown next to the stage. */
  hint: string;
  /** Rendering tech, surfaced as a tag. */
  tech: 'WebGL' | 'Canvas 2D' | 'SVG';
  /**
   * `framed` effects bring their own bounded stage and sit in a centred column;
   * `fullscreen` effects fill the viewport with only a thin overlay of chrome.
   */
  layout: ShowcaseLayout;
};

export const SHOWCASE_EFFECTS: readonly ShowcaseEffect[] = [
  {
    slug: 'particle-assembly',
    name: 'Particle Assembly',
    tagline: 'The Kortix mark in hard pixels — breathing, and yours to smear.',
    description:
      'The Kortix symbol rendered as hard, Rauch-style pixels. It materializes, then breathes — a radial wave easing the mark open and closed — while your cursor shoves the pixels around before they spring back home. A tenth glow in Kortix orange.',
    hint: 'Move your cursor through it — it breathes on its own',
    tech: 'Canvas 2D',
    layout: 'fullscreen',
  },
  {
    slug: 'magnetic-field',
    name: 'Magnetic Field',
    tagline: 'A grid of marks that lean into your cursor.',
    description:
      'A grid of Kortix marks that lean into your cursor — they grow, tilt, and warm to Kortix orange within a falloff radius, and breathe gently when idle.',
    hint: 'Move your cursor across the grid',
    tech: 'Canvas 2D',
    layout: 'framed',
  },
  {
    slug: 'aurora-mark',
    name: 'Aurora Mark',
    tagline: 'The mark as a window onto a brand aurora.',
    description:
      'The Kortix symbol as a window onto a slowly drifting multi-colour aurora — orange, blue, violet, and green — masked to the mark and glowing on ink.',
    hint: 'Loops on its own',
    tech: 'SVG',
    layout: 'framed',
  },
  {
    slug: 'currents',
    name: 'Currents',
    tagline: 'Particles drifting through a living flow field.',
    description:
      'Thousands of particles ride a slowly shifting flow field, leaving silky trails — white currents laced with Kortix orange on ink.',
    hint: 'Loops on its own',
    tech: 'Canvas 2D',
    layout: 'framed',
  },
  {
    slug: 'kortix-currents',
    name: 'Kortix Currents',
    tagline: 'Currents glow the Kortix mark into being.',
    description:
      'A full-frame flow field with no drawn logo — no stroke, no fill. Wherever the currents touch the Kortix mark in the centre, its edge glows softly in orange, forming the mark out of the glow and fading as the flow moves on.',
    hint: 'Loops on its own · the mark glows where currents touch it',
    tech: 'Canvas 2D',
    layout: 'framed',
  },
  {
    slug: 'liquid',
    name: 'Liquid',
    tagline: 'Molten Kortix-orange metaballs, merging and parting.',
    description:
      'Gooey orange metaballs drift, merge, and separate in a slow lava — an SVG goo filter standing in for surface tension.',
    hint: 'Loops on its own',
    tech: 'SVG',
    layout: 'framed',
  },
];

export function getEffect(slug: string): ShowcaseEffect | undefined {
  return SHOWCASE_EFFECTS.find((effect) => effect.slug === slug);
}
