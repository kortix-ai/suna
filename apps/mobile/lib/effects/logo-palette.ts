/**
 * The colours of the Kortix symbol (`MetalKortixLogo`), as a choice the user
 * can make. Pure: no React Native, no THEME import (the caller passes the
 * accent's `hsl(H S% L%)` string), so it runs under `bun test`.
 *
 * Every colour is predefined: a palette is one brand accent (`THEME.accent.*`)
 * in the metal finish (Jay, 2026-09-22: pastel removed, metal only). There is
 * no free colour picker, and no new colour literal.
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

interface LogoPalette {
  id: string;
  label: string;
  accent: LogoAccent | null;
}

/** The picker's list, in order. Every colour is predefined: one brand accent, metal finish. */
export const LOGO_PALETTES = [
  { id: 'default', label: 'Graphite', accent: null },
  { id: 'gold', label: 'Gold', accent: 'yellow' },
  { id: 'copper', label: 'Copper', accent: 'orange' },
  { id: 'ruby', label: 'Ruby', accent: 'red' },
  { id: 'amethyst', label: 'Amethyst', accent: 'purple' },
  { id: 'cobalt', label: 'Cobalt', accent: 'blue' },
  { id: 'emerald', label: 'Emerald', accent: 'green' },
] as const satisfies ReadonlyArray<LogoPalette>;

export type LogoPaletteId = (typeof LOGO_PALETTES)[number]['id'];
export const DEFAULT_LOGO_PALETTE_ID: LogoPaletteId = 'default';

export function isLogoPaletteId(value: unknown): value is LogoPaletteId {
  return LOGO_PALETTES.some((palette) => palette.id === value);
}

type Shade = [saturationScale: number, lightness: number];

/** Saturation scale and lightness (%) of the two colours, per page tone. */
const SHADES: Record<LogoTone, { first: Shade; second: Shade }> = {
  dark: { first: [0.9, 78], second: [0.6, 12] },
  light: { first: [0.8, 20], second: [0.7, 84] },
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
export function logoPaletteColors(accentHsl: string | null, tone: LogoTone): { first: Rgba; second: Rgba } | null {
  if (!accentHsl) return null;
  const { h, s } = parseHsl(accentHsl);
  const shade = SHADES[tone];
  return {
    first: hslToRgba(h, s * shade.first[0], shade.first[1]),
    second: hslToRgba(h, s * shade.second[0], shade.second[1]),
  };
}

/**
 * The dither's cell colour for an accent, or null: the tone's default. It is
 * the palette's highlight (`first`), so a coloured dither and a coloured
 * heatmap share one colour.
 */
export function logoFrontColor(accentHsl: string | null, tone: LogoTone): Rgba | null {
  return logoPaletteColors(accentHsl, tone)?.first ?? null;
}

/** The same two colours as `hsl(...)` strings, for a swatch in the picker. */
export function logoPaletteSwatch(
  accentHsl: string | null,
  tone: LogoTone
): { highlight: string; body: string } | null {
  if (!accentHsl) return null;
  const { h, s } = parseHsl(accentHsl);
  const shade = SHADES[tone];
  const hsl = ([scale, l]: Shade) => `hsl(${h} ${Math.round(s * scale * 10) / 10}% ${l}%)`;
  return { highlight: hsl(shade.first), body: hsl(shade.second) };
}
