'use client';

/**
 * The three Kortix marks a project icon can use: the vector symbol, the pixel
 * symbol, and the dithered symbol. They are not Phosphor icons, so the glyph
 * registry and `glyphFace` take them from here.
 *
 * Each one draws in `currentColor` inside a square viewBox, centred with the
 * same optical margin as a Phosphor glyph, so `size-4` / `size-5` from the
 * host sizes it exactly like the icons around it.
 */
import type { Icon, IconProps } from '@phosphor-icons/react';
import { PIXEL_KORTIX_ROWS } from '@kortix/shared/pixel-mark';
import { createElement, forwardRef, useId } from 'react';

import { cn } from '../lib/utils';
import { useUiBrand, type UiBrand } from '../providers/ui-provider';

/** The Kortix symbol path, 30 x 25 (apps/web/public/kortix-symbol.svg). */
const SYMBOL_PATH =
  'M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z';

/** 30 x 25 symbol centred in a 34 x 34 square. */
const SYMBOL_VIEWBOX = '-2 -4.5 34 34';

/**
 * Pixel cells. A full cell (`#`) is solid; a curve cell (`+`) is the same
 * colour at 42% instead of the 1-unit checker `PixelKortixMark` draws: at
 * 16-20 px the checker falls below one device pixel and blurs into stripes.
 */
const PIXEL_PITCH = 6;
const PIXEL_CELL = 5.2;
const PIXEL_CELLS = PIXEL_KORTIX_ROWS.flatMap((row, y) =>
  [...row].flatMap((cell, x) =>
    cell === ' ' ? [] : [{ x: x * PIXEL_PITCH, y: y * PIXEL_PITCH, curve: cell === '+' }],
  ),
);
/** 71.2 x 59.2 grid centred in an 80 x 80 square. */
const PIXEL_VIEWBOX = '-4.4 -10.4 80 80';

/**
 * Dither cells: a diagonal ramp (bright top-left, fading bottom-right) through
 * an 8 x 8 Bayer matrix, on a 24 x 20 grid of 1.25-unit cells over the 30 x 25
 * symbol. Computed once at module load; one path string.
 */
const BAYER_8 = (() => {
  const build = (n: number): number[][] => {
    if (n === 1) return [[0]];
    const half = build(n / 2);
    const quadrant = [
      [0, 2],
      [3, 1],
    ];
    return Array.from({ length: n }, (_, y) =>
      Array.from(
        { length: n },
        (_, x) => half[y % (n / 2)]![x % (n / 2)]! * 4 + quadrant[Math.floor(y / (n / 2))]![Math.floor(x / (n / 2))]!,
      ),
    );
  };
  return build(8).map((row) => row.map((v) => (v + 0.5) / 64));
})();

const DITHER_PATH = (() => {
  const unit = 1.25;
  const cols = 24;
  const rows = 20;
  let d = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ramp = 1 - ((x / cols) * 0.55 + (y / rows) * 0.45);
      if (ramp * 1.15 > BAYER_8[y % 8]![x % 8]!) d += `M${x * unit} ${y * unit}h${unit}v${unit}h-${unit}z`;
    }
  }
  return d;
})();

function svgProps(props: IconProps, viewBox: string) {
  const { size = '1em', color, weight: _weight, mirrored: _mirrored, alt, children, ...rest } = props;
  return {
    rest: {
      xmlns: 'http://www.w3.org/2000/svg',
      width: size,
      height: size,
      viewBox,
      fill: color ?? 'currentColor',
      'aria-hidden': alt ? undefined : true,
      ...rest,
    },
    alt,
    children,
  };
}

const KortixMark = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const { rest, alt, children } = svgProps(props, SYMBOL_VIEWBOX);
  return createElement('svg', { ref, ...rest }, alt ? createElement('title', null, alt) : null, createElement('path', { d: SYMBOL_PATH }), children);
}) as Icon;
KortixMark.displayName = 'KortixMarkGlyph';

const KortixPixel = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const { rest, alt, children } = svgProps(props, PIXEL_VIEWBOX);
  return createElement(
    'svg',
    { ref, ...rest },
    alt ? createElement('title', null, alt) : null,
    ...PIXEL_CELLS.map((cell) =>
      createElement('rect', {
        key: `${cell.x}-${cell.y}`,
        x: cell.x,
        y: cell.y,
        width: PIXEL_CELL,
        height: PIXEL_CELL,
        opacity: cell.curve ? 0.42 : undefined,
      }),
    ),
    children,
  );
}) as Icon;
KortixPixel.displayName = 'KortixPixelGlyph';

const KortixDither = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  // One mask per instance: a `url(#id)` into another copy of this SVG stops
  // painting when that copy is hidden with `display: none`.
  const maskId = `kortix-dither-${useId().replace(/[^\w-]/g, '')}`;
  const { rest, alt, children } = svgProps(props, SYMBOL_VIEWBOX);
  return createElement(
    'svg',
    { ref, ...rest, shapeRendering: 'crispEdges' },
    alt ? createElement('title', null, alt) : null,
    createElement(
      'defs',
      null,
      createElement(
        'mask',
        { id: maskId },
        createElement('path', { d: SYMBOL_PATH, fill: '#fff', shapeRendering: 'geometricPrecision' }),
      ),
    ),
    createElement(
      'g',
      { mask: `url(#${maskId})` },
      createElement('rect', { width: 30, height: 25, opacity: 0.28 }),
      createElement('path', { d: DITHER_PATH }),
    ),
    children,
  );
}) as Icon;
KortixDither.displayName = 'KortixDitherGlyph';

/** The glyph name of the Enterprise brand icon. A host draws it edge to edge
 *  (no padding) when the brand image is present: see `isFullBleedGlyph`. */
export const BRAND_GLYPH = 'BrandIcon';

/** The square brand image an Enterprise account set, light and dark, or null. */
export function brandIconSources(brand: UiBrand | null): { light: string; dark: string | null } | null {
  const light = brand?.icon_url ?? brand?.logo_url ?? null;
  if (!light) return null;
  const dark = brand?.icon_dark_url ?? brand?.logo_dark_url ?? null;
  return { light, dark: dark && dark !== light ? dark : null };
}

/**
 * The organization's own icon (Enterprise branding), drawn as its image: a
 * brand mark keeps its own colours, so it is not tinted; the tile wash under
 * it still takes the chosen colour. A dark-scheme variant swaps by the theme
 * class, like `KortixLogo`. Without branding (outside an Enterprise account,
 * or after the branding was removed) it draws the Kortix mark instead.
 */
const BrandIcon = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const sources = brandIconSources(useUiBrand());
  if (!sources) return createElement(KortixMark, { ...props, ref });
  const { size, className, style } = props;
  const img = (src: string, extra: string) =>
    createElement('img', {
      src,
      alt: '',
      draggable: false,
      className: cn('size-full object-cover select-none', extra),
    });
  return createElement(
    'span',
    {
      'aria-hidden': true,
      'data-brand-icon': '',
      // A class, not an inline size, so the host's `size-*` (e.g. `size-full`
      // for a full-bleed tile) wins; an explicit `size` prop still applies.
      className: cn('inline-flex size-[1em] shrink-0 items-center justify-center', className),
      style: size != null ? { width: size, height: size, ...style } : style,
    },
    img(sources.light, sources.dark ? 'dark:hidden' : ''),
    sources.dark ? img(sources.dark, 'hidden dark:block') : null,
  );
}) as Icon;
BrandIcon.displayName = 'BrandIconGlyph';

/**
 * The full-bleed brand tile's border: a 1px ring drawn OVER the image (an
 * inset ring on the tile itself would paint under it), so a light or
 * transparent logo still reads as a tile. One literal class list for every
 * host, so Tailwind extracts it.
 */
export const FULL_BLEED_BORDER =
  "relative overflow-hidden after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:inset-ring-1 after:inset-ring-foreground/15 after:content-['']";

/** True when this glyph is the brand icon AND the account has a brand image:
 *  the tile then shows the image full bleed instead of a padded icon. */
export function useFullBleedGlyph(name: string | undefined): boolean {
  const brand = useUiBrand();
  return name === BRAND_GLYPH && brandIconSources(brand) !== null;
}

/** Glyphs drawn by their own component rather than one generated path. */
export const KORTIX_GLYPH_COMPONENTS: Readonly<Record<string, Icon>> = {
  KortixMark,
  KortixPixel,
  KortixDither,
  BrandIcon,
};

export const KORTIX_GLYPH_SEARCH: Readonly<Record<string, string[]>> = {
  KortixMark: ['kortixmark', 'kortix', 'logo', 'brand', 'mark'],
  KortixPixel: ['kortixpixel', 'kortix', 'pixel', 'logo', 'brand', 'retro'],
  KortixDither: ['kortixdither', 'kortix', 'dither', 'logo', 'brand', 'gradient'],
  BrandIcon: ['brandicon', 'brand', 'logo', 'company', 'organization', 'org'],
};
