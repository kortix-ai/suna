'use client';

/**
 * name -> a component that draws a catalogue glyph solid, without the Phosphor
 * component behind it.
 *
 * EntityAvatar is on every app page. It draws a project's glyph through this
 * module rather than `glyph-registry`, which carries every Phosphor weight of
 * every catalogue glyph. The path data itself (`glyph-paths.generated.ts`,
 * ~950 glyphs, 365 KB raw / 114 KB gzip on 2026-11-05) is ALSO too big for
 * every page, so it loads on first use: the face renders an empty `<path>` in
 * the same `IconBase` shell (same size, colour, mirroring and ref) and fills it
 * in when the module arrives. A page with no glyph project never fetches it.
 *
 * The server always renders the empty shell, so server and client markup
 * agree at hydration; the path paints one tick later.
 *
 * The three Kortix marks are their own small components and draw at once.
 */
import { type Icon, IconBase, type IconProps } from '@phosphor-icons/react';
import { createElement, forwardRef, useEffect, useSyncExternalStore } from 'react';

import { isProjectGlyphName } from '@kortix/shared';
import { KORTIX_GLYPH_COMPONENTS } from './kortix-glyphs';
import { ICON_WEIGHTS } from '../lib/icon-config';

type GlyphPaths = Readonly<Record<string, string>>;

let paths: GlyphPaths | null = null;
let pending: Promise<GlyphPaths> | null = null;
const listeners = new Set<() => void>();

/** Fetch the path module once; every caller shares the same promise. */
export function loadGlyphPaths(): Promise<GlyphPaths> {
  if (paths) return Promise.resolve(paths);
  pending ??= import('./glyph-paths.generated').then((module) => {
    paths = module.GLYPH_PATHS;
    for (const listener of listeners) listener();
    return paths;
  });
  return pending;
}

/** The path data of one glyph, or undefined until `loadGlyphPaths` resolves. */
export function glyphPathData(name: string): string | undefined {
  return paths && Object.hasOwn(paths, name) ? paths[name] : undefined;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const clientSnapshot = () => paths;
const serverSnapshot = () => null;

const faces = new Map<string, Icon>();

export function glyphFace(name: string): Icon | null {
  const cached = faces.get(name);
  if (cached) return cached;
  // The Kortix marks are drawn by their own components, not one Phosphor path.
  if (Object.hasOwn(KORTIX_GLYPH_COMPONENTS, name)) return KORTIX_GLYPH_COMPONENTS[name]!;
  // Existence comes from the shared catalogue, which is small and already on
  // every page; the path data is not needed to answer "is this a glyph?".
  if (!isProjectGlyphName(name)) return null;

  const Face = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const loaded = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
    useEffect(() => {
      if (!paths) void loadGlyphPaths();
    }, []);
    const path = createElement('path', { d: loaded?.[name] ?? '' });
    // Every weight draws the generated one: a project glyph is always solid
    // (GLYPH_WEIGHT in glyph-paths-source.tsx), whatever the app's icon weight.
    const weights = new Map(ICON_WEIGHTS.map((weight) => [weight, path]));
    return createElement(IconBase, { ref, ...props, weights });
  }) as Icon;
  Face.displayName = `${name}Glyph`;
  faces.set(name, Face);
  return Face;
}
