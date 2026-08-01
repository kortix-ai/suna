/**
 * The tint a project's GLYPH wears.
 *
 * Same treatment as an emoji tile — a pale `--color-glyph-fill-*` under a 1px
 * `--color-glyph-ring-*` inset ring — so a glyph project and an emoji project
 * read as one family in the grid. The difference is where the hue comes from:
 * an emoji's is DERIVED from the glyph (emoji-tint.ts), a glyph's is CHOSEN by
 * the user and stored alongside the name.
 *
 * The ring token also paints the glyph itself. A monochrome icon has no colour
 * of its own, so the colour the user picked has to be visible somewhere the eye
 * lands, and a 1px ring alone is too quiet to carry it.
 */
import { PROJECT_GLYPH_COLORS, type ProjectGlyphColor } from '@kortix/shared';

/**
 * Every class below is a LITERAL string. Do not build one with a template
 * literal or a .map(): Tailwind v4 extracts class names by scanning source
 * TEXT, so an interpolated name emits no CSS at all and the tints silently
 * never paint. That has already happened once on this feature.
 *
 * There is no `dark:` set — each token is a light-dark() pair and :root / .dark
 * set color-scheme, so one class covers both themes.
 *
 * `border-0` is part of the tint, not the host's business: both hosts bring a
 * 1px border of their own (EntityAvatar's base class list, Button's `outline`
 * variant) and it would sit outside the inset ring as a grey second edge.
 */
const TINT: Record<ProjectGlyphColor, string> = {
  grey: 'border-0 bg-glyph-fill-grey inset-ring-1 inset-ring-glyph-ring-grey',
  red: 'border-0 bg-glyph-fill-red inset-ring-1 inset-ring-glyph-ring-red',
  orange: 'border-0 bg-glyph-fill-orange inset-ring-1 inset-ring-glyph-ring-orange',
  yellow: 'border-0 bg-glyph-fill-yellow inset-ring-1 inset-ring-glyph-ring-yellow',
  lime: 'border-0 bg-glyph-fill-lime inset-ring-1 inset-ring-glyph-ring-lime',
  blue: 'border-0 bg-glyph-fill-blue inset-ring-1 inset-ring-glyph-ring-blue',
  purple: 'border-0 bg-glyph-fill-purple inset-ring-1 inset-ring-glyph-ring-purple',
  magenta: 'border-0 bg-glyph-fill-magenta inset-ring-1 inset-ring-glyph-ring-magenta',
};

/**
 * The resting fill again, under `hover:`.
 *
 * Only an INTERACTIVE host needs it. Button's `outline` variant carries
 * `hover:bg-foreground/5`, and a `:hover` rule outranks the resting
 * `bg-glyph-fill-*` on specificity, so hovering the trigger would wipe the tint
 * to a neutral wash. Restating the fill at the same modifier is what holds it.
 */
const TINT_HOVER: Record<ProjectGlyphColor, string> = {
  grey: 'hover:bg-glyph-fill-grey',
  red: 'hover:bg-glyph-fill-red',
  orange: 'hover:bg-glyph-fill-orange',
  yellow: 'hover:bg-glyph-fill-yellow',
  lime: 'hover:bg-glyph-fill-lime',
  blue: 'hover:bg-glyph-fill-blue',
  purple: 'hover:bg-glyph-fill-purple',
  magenta: 'hover:bg-glyph-fill-magenta',
};

/** The glyph's own colour — the ring token, not the fill. */
const FOREGROUND: Record<ProjectGlyphColor, string> = {
  grey: 'text-glyph-ring-grey',
  red: 'text-glyph-ring-red',
  orange: 'text-glyph-ring-orange',
  yellow: 'text-glyph-ring-yellow',
  lime: 'text-glyph-ring-lime',
  blue: 'text-glyph-ring-blue',
  purple: 'text-glyph-ring-purple',
  magenta: 'text-glyph-ring-magenta',
};

/**
 * Unknown colours resolve to grey rather than to an empty string.
 *
 * An empty string leaves an untinted, unringed tile, which reads as a rendering
 * bug. Grey is a real member of the palette, so the fallback is
 * indistinguishable from a deliberate choice. The server rejects colours
 * outside the palette, so this only fires on stale cached data or a hand-edited
 * row — exactly the cases where failing quietly and legibly is right.
 */
const FALLBACK: ProjectGlyphColor = 'grey';

function resolve(color: string): ProjectGlyphColor {
  return (PROJECT_GLYPH_COLORS as readonly string[]).includes(color)
    ? (color as ProjectGlyphColor)
    : FALLBACK;
}

/** The tile: fill + 1px inset ring, in the chosen colour. */
export function glyphTint(color: string): string {
  return TINT[resolve(color)];
}

/** Holds `glyphTint`'s fill through a host variant's own hover background. */
export function glyphTintHover(color: string): string {
  return TINT_HOVER[resolve(color)];
}

/** The glyph itself, in the ring colour. */
export function glyphForeground(color: string): string {
  return FOREGROUND[resolve(color)];
}
