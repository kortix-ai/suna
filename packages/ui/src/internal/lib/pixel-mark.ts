/**
 * An agent's pixel mark on its tile: the shape from `pixelMarkShape`
 * (`@kortix/shared/pixel-mark`) plus a tile tone from a second hash of the slug.
 */

import { fnv1a, pixelMarkShape } from '@kortix/shared/pixel-mark';

export { passesPixelMarkGate } from '@kortix/shared/pixel-mark';

export interface PixelMarkTone {
  name: string;
  tile: string;
  ink: string;
  /** Dark theme: the pair inverts, so the tile stays visible on a dark page. */
  tileDark: string;
  inkDark: string;
}

const tone = (name: string, tile: string, ink: string): PixelMarkTone => ({
  name,
  tile,
  ink,
  tileDark: ink,
  inkDark: tile,
});

export const PIXEL_MARK_TONES: readonly PixelMarkTone[] = [
  tone('graphite', '#EDEDED', '#191919'),
  tone('sand', '#F1EBDD', '#6B5A3A'),
  tone('moss', '#E6EDE0', '#3F5A33'),
  tone('sea', '#E2ECF0', '#2E5566'),
  tone('blue', '#E6EEFF', '#2457C5'),
  tone('plum', '#EEE6F0', '#5E3A68'),
  tone('clay', '#F3E6E0', '#7A4532'),
  tone('slate', '#E4E7EC', '#3B4656'),
];

/** The starter's `kortix` agent and My Kortix (slug `mykortix`) keep the brand tile. */
const BRAND: PixelMarkTone = {
  name: 'brand',
  tile: '#1F1F1F',
  ink: '#FFFFFF',
  tileDark: '#2C2C2C',
  inkDark: '#FFFFFF',
};
const RESERVED: Record<string, PixelMarkTone> = { kortix: BRAND, mykortix: BRAND, meta: BRAND };

export function pixelMark(slug: string) {
  const tone = RESERVED[slug] ?? PIXEL_MARK_TONES[fnv1a(`${slug}#tone`) % PIXEL_MARK_TONES.length];
  return { ...pixelMarkShape(slug), tone };
}
