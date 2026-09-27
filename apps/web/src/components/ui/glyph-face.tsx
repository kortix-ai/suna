'use client';

/**
 * name -> a component that draws a catalogue glyph in the app's icon weight,
 * without the Phosphor component behind it.
 *
 * EntityAvatar is on every app page. Drawing its glyph through
 * `glyph-registry` shipped all 202 Phosphor components with every shipped
 * weight — the largest client chunk (345 KB decoded on the project home,
 * measured 2026-09-27) — to draw one path in one weight. This renders the same
 * path through Phosphor's own `IconBase`, so the markup, the IconContext
 * defaults (size, colour, mirroring) and the ref are exactly what the
 * component rendered. glyph-face.test.tsx asserts the markup matches for every
 * glyph.
 *
 * The glyph picker keeps the full registry: it shows glyphs to choose from and
 * loads only in the settings and new-workspace forms.
 */
import { type Icon, IconBase, type IconProps } from '@phosphor-icons/react';
import { createElement, forwardRef } from 'react';

import { GLYPH_PATHS } from '@/components/ui/glyph-paths.generated';
import { ICON_WEIGHTS } from '@/lib/icons/icon-config';

const faces = new Map<string, Icon>();

export function glyphFace(name: string): Icon | null {
  const cached = faces.get(name);
  if (cached) return cached;
  if (!Object.hasOwn(GLYPH_PATHS, name)) return null;
  const path = createElement('path', { d: GLYPH_PATHS[name] });
  // Every weight draws the generated one: an avatar always wears the app's
  // icon weight, which is the weight the path was generated in.
  const weights = new Map(ICON_WEIGHTS.map((weight) => [weight, path]));
  const Face = forwardRef<SVGSVGElement, IconProps>((props, ref) =>
    createElement(IconBase, { ref, ...props, weights }),
  ) as Icon;
  Face.displayName = `${name}Glyph`;
  faces.set(name, Face);
  return Face;
}
