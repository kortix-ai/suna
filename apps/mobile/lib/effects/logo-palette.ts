/**
 * The colours of the liquid-metal Kortix symbol (`MetalKortixLogo`), as a choice
 * the user can make. Pure: no React Native, no THEME import (the caller passes
 * the accent's `hsl(H S% L%)` string), so it runs under `bun test`.
 *
 * Every colour is predefined: a palette is one brand accent (`THEME.accent.*`)
 * in one of two finishes, metal or pastel. There is no free colour picker, and
 * no new colour literal.
 * The shader takes two colours: `first` draws the outline and the streaks,
 * `second` the body. Each palette keeps the default metal's light / dark
 * relation, so a coloured symbol reads the same way as the graphite one:
 *  - dark page: a bright highlight over a near-black body
 *  - light page: a dark outline over a pale body (a bright first colour would
 *    vanish on white: the shader maps low heat to transparent)
 */
export type LogoTone = 'light' | 'dark';
export type Rgba = [number, number, number, number];
export type LogoAccent = 'yellow' | 'orange' | 'red' | 'purple' | 'blue' | 'green';

/** Metal keeps the default's hard light / dark contrast; pastel is the same accent, softer and lighter. */
export type LogoFinish = 'metal' | 'pastel';

interface LogoPalette {
  id: string;
  label: string;
  accent: LogoAccent | null;
  finish: LogoFinish;
}

/** The picker's groups, in order. Every colour is predefined: a brand accent in one of two finishes. */
export const LOGO_PALETTE_GROUPS = [
  {
    title: 'Metal',
    palettes: [
      { id: 'default', label: 'Graphite', accent: null, finish: 'metal' },
      { id: 'gold', label: 'Gold', accent: 'yellow', finish: 'metal' },
      { id: 'copper', label: 'Copper', accent: 'orange', finish: 'metal' },
      { id: 'ruby', label: 'Ruby', accent: 'red', finish: 'metal' },
      { id: 'amethyst', label: 'Amethyst', accent: 'purple', finish: 'metal' },
      { id: 'cobalt', label: 'Cobalt', accent: 'blue', finish: 'metal' },
      { id: 'emerald', label: 'Emerald', accent: 'green', finish: 'metal' },
    ],
  },
  {
    title: 'Pastel',
    palettes: [
      { id: 'lemon', label: 'Lemon', accent: 'yellow', finish: 'pastel' },
      { id: 'peach', label: 'Peach', accent: 'orange', finish: 'pastel' },
      { id: 'blush', label: 'Blush', accent: 'red', finish: 'pastel' },
      { id: 'lavender', label: 'Lavender', accent: 'purple', finish: 'pastel' },
      { id: 'sky', label: 'Sky', accent: 'blue', finish: 'pastel' },
      { id: 'mint', label: 'Mint', accent: 'green', finish: 'pastel' },
    ],
  },
] as const satisfies ReadonlyArray<{ title: string; palettes: ReadonlyArray<LogoPalette> }>;

export const LOGO_PALETTES = LOGO_PALETTE_GROUPS.flatMap((group) => [...group.palettes]);

export type LogoPaletteId = (typeof LOGO_PALETTE_GROUPS)[number]['palettes'][number]['id'];
export const DEFAULT_LOGO_PALETTE_ID: LogoPaletteId = 'default';

export function isLogoPaletteId(value: unknown): value is LogoPaletteId {
  return LOGO_PALETTES.some((palette) => palette.id === value);
}

type Shade = [saturationScale: number, lightness: number];

/** Saturation scale and lightness (%) of the two colours, per finish and page tone. */
const SHADES: Record<LogoFinish, Record<LogoTone, { first: Shade; second: Shade }>> = {
  metal: {
    dark: { first: [0.9, 78], second: [0.6, 12] },
    light: { first: [0.8, 20], second: [0.7, 84] },
  },
  pastel: {
    dark: { first: [0.7, 90], second: [0.45, 64] },
    // The outline stays mid-dark: a pale first colour would vanish on a white page.
    light: { first: [0.55, 48], second: [0.6, 88] },
  },
};

const HSL_PARTS = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/;

function parseHsl(hsl: string): { h: number; s: number } {
  const parts = HSL_PARTS.exec(hsl.trim());
  if (!parts)
    throw new Error(`logo-palette expects a THEME 'hsl(H S% L%)' string, received: ${hsl}`);
  return { h: Number(parts[1]), s: Number(parts[2]) };
}

/** h in degrees, s and l in percent → the shader's `[r, g, b, 1]`, each 0 to 1. */
export function hslToRgba(h: number, s: number, l: number): Rgba {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = light - chroma / 2;
  const channel = (v: number) => Math.round((v + m) * 1000) / 1000;
  return [channel(r), channel(g), channel(b), 1];
}

/** The shader's two colours for an accent, or null: the logo's own default metal. */
export function logoPaletteColors(
  accentHsl: string | null,
  tone: LogoTone,
  finish: LogoFinish
): { first: Rgba; second: Rgba } | null {
  if (!accentHsl) return null;
  const { h, s } = parseHsl(accentHsl);
  const shade = SHADES[finish][tone];
  return {
    first: hslToRgba(h, s * shade.first[0], shade.first[1]),
    second: hslToRgba(h, s * shade.second[0], shade.second[1]),
  };
}

/** The same two colours as `hsl(...)` strings, for a swatch in the picker. */
export function logoPaletteSwatch(
  accentHsl: string | null,
  tone: LogoTone,
  finish: LogoFinish
): { highlight: string; body: string } | null {
  if (!accentHsl) return null;
  const { h, s } = parseHsl(accentHsl);
  const shade = SHADES[finish][tone];
  const hsl = ([scale, l]: Shade) => `hsl(${h} ${Math.round(s * scale * 10) / 10}% ${l}%)`;
  return { highlight: hsl(shade.first), body: hsl(shade.second) };
}
