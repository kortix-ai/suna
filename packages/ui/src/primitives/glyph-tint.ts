/**
 * The tint a project's GLYPH wears: a solid icon in the chosen colour on a
 * light wash of that same colour, with no border.
 *
 * One CSS variable, `--glyph`, carries the colour. The tile mixes it into a
 * wash (`glyphTint`) and the icon paints in it (`glyphForeground`). A preset
 * colour sets `--glyph` through a literal class per preset, pointing at its
 * `--glyph-solid-*` custom property (theme.css) (a light-dark() pair, so one class covers
 * both themes). A custom `#rrggbb` colour cannot be a class, so it comes in
 * as an inline style from `glyphStyle`. Every host that paints a glyph spreads
 * `glyphStyle(color)` on the same element as `glyphTint` / `glyphForeground`,
 * or on an ancestor of it.
 *
 * Every class below is a LITERAL string. Tailwind v4 extracts class names by
 * scanning source TEXT, so an interpolated name emits no CSS at all.
 *
 * `border-0` is part of the tint: both hosts bring a 1px border of their own
 * (EntityAvatar's base class list, Button's `outline` variant), and the tile
 * has no edge in this design.
 */
import type { CSSProperties } from 'react';

import {
  isProjectGlyphColor,
  isProjectGlyphPaletteColor,
  type ProjectGlyphPaletteColor,
} from '@kortix/shared';

const VAR: Record<ProjectGlyphPaletteColor, string> = {
  grey: '[--glyph:var(--glyph-solid-grey)]',
  red: '[--glyph:var(--glyph-solid-red)]',
  orange: '[--glyph:var(--glyph-solid-orange)]',
  yellow: '[--glyph:var(--glyph-solid-yellow)]',
  lime: '[--glyph:var(--glyph-solid-lime)]',
  blue: '[--glyph:var(--glyph-solid-blue)]',
  purple: '[--glyph:var(--glyph-solid-purple)]',
  magenta: '[--glyph:var(--glyph-solid-magenta)]',
};

/** The wash: 14% of the colour in light, 20% in dark. */
const WASH =
  'border-0 bg-[color-mix(in_oklab,var(--glyph)_14%,transparent)] dark:bg-[color-mix(in_oklab,var(--glyph)_20%,transparent)]';

/** The same wash under `hover:`, for a host variant with its own hover fill. */
const WASH_HOVER =
  'hover:bg-[color-mix(in_oklab,var(--glyph)_14%,transparent)] dark:hover:bg-[color-mix(in_oklab,var(--glyph)_20%,transparent)]';

/** `color:` is required: Tailwind v4 reads a bare `text-[var(--x)]` as a font size. */
const FOREGROUND = 'text-[color:var(--glyph)]';

const HOVER_WASH =
  'hover:bg-[color-mix(in_oklab,var(--glyph)_14%,transparent)] dark:hover:bg-[color-mix(in_oklab,var(--glyph)_20%,transparent)] data-[selected=true]:bg-[color-mix(in_oklab,var(--glyph)_14%,transparent)] dark:data-[selected=true]:bg-[color-mix(in_oklab,var(--glyph)_20%,transparent)]';

const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

/**
 * Unknown colours resolve to grey. The server rejects anything that is not a
 * preset or `#rrggbb`, so this only fires on stale cached data or a
 * hand-edited row.
 */
function presetVar(color: string): string {
  if (isProjectGlyphPaletteColor(color)) return VAR[color];
  return isProjectGlyphColor(color) ? '' : VAR.grey;
}

/** `#rrggbb` -> `{ '--glyph': '#rrggbb' }`; a preset or unknown colour -> undefined. */
export function glyphStyle(color: string): CSSProperties | undefined {
  if (isProjectGlyphPaletteColor(color) || !isProjectGlyphColor(color)) return undefined;
  return { '--glyph': color } as CSSProperties;
}

/** The tile: the colour's wash, no border. Pair with `glyphStyle(color)`. */
export function glyphTint(color: string): string {
  return join(presetVar(color), WASH);
}

/** Holds `glyphTint`'s wash through a host variant's own hover background. */
export function glyphTintHover(color: string): string {
  return join(presetVar(color), WASH_HOVER);
}

/** The glyph itself, solid, in the colour. Pair with `glyphStyle(color)`. */
export function glyphForeground(color: string): string {
  return join(presetVar(color), FOREGROUND);
}

/** The wash on hover only, for a grid cell that has no resting tile. */
export function glyphHoverWash(color: string): string {
  return join(presetVar(color), HOVER_WASH);
}
