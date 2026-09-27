import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_LOGO_PALETTE_ID,
  LOGO_PALETTES,
  hslToRgba,
  isLogoPaletteId,
  logoFrontColor,
  logoPaletteColors,
  logoPaletteSwatch,
} from './logo-palette';

describe('LOGO_PALETTES', () => {
  test('starts with the default metal, which has no accent', () => {
    expect(LOGO_PALETTES[0]).toEqual({ id: 'default', label: 'Graphite', accent: null });
    expect(DEFAULT_LOGO_PALETTE_ID).toBe('default');
  });

  test('every other palette names a brand accent, and ids are unique', () => {
    const ids = LOGO_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const palette of LOGO_PALETTES.slice(1)) expect(palette.accent).not.toBeNull();
  });
});

describe('isLogoPaletteId', () => {
  test('accepts a listed id and rejects anything else', () => {
    expect(isLogoPaletteId('gold')).toBe(true);
    expect(isLogoPaletteId('default')).toBe(true);
    expect(isLogoPaletteId('mint')).toBe(false);
    expect(isLogoPaletteId('neon')).toBe(false);
    expect(isLogoPaletteId(undefined)).toBe(false);
  });
});

describe('hslToRgba', () => {
  test('converts the primaries and greys', () => {
    expect(hslToRgba(0, 100, 50)).toEqual([1, 0, 0, 1]);
    expect(hslToRgba(120, 100, 50)).toEqual([0, 1, 0, 1]);
    expect(hslToRgba(240, 100, 50)).toEqual([0, 0, 1, 1]);
    expect(hslToRgba(0, 0, 100)).toEqual([1, 1, 1, 1]);
    expect(hslToRgba(0, 0, 0)).toEqual([0, 0, 0, 1]);
  });
});

describe('logoPaletteColors', () => {
  const blue = 'hsl(210 93% 56.9%)';
  const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  test('no accent means the logo keeps its own default colours', () => {
    expect(logoPaletteColors(null, 'dark')).toBeNull();
    expect(logoPaletteColors(null, 'light')).toBeNull();
  });

  test('dark: a bright highlight over a dark body, as the default metal has', () => {
    const colors = logoPaletteColors(blue, 'dark')!;
    expect(luminance(colors.first)).toBeGreaterThan(0.5);
    // The default metal's body is 0.141 grey: a palette's body is as dark.
    expect(luminance(colors.second)).toBeLessThan(0.2);
  });

  test('light: a dark outline over a light body, so it shows on a white page', () => {
    const colors = logoPaletteColors(blue, 'light')!;
    expect(luminance(colors.first)).toBeLessThan(0.25);
    expect(luminance(colors.second)).toBeGreaterThan(0.6);
  });

  test('keeps the accent hue: blue stays blue', () => {
    const [r, , b] = logoPaletteColors(blue, 'dark')!.first;
    expect(b).toBeGreaterThan(r);
  });

  test('rejects a string that is not a THEME hsl colour', () => {
    expect(() => logoPaletteColors('#ff0000', 'dark')).toThrow();
  });
});

describe('logoPaletteSwatch', () => {
  test('gives the two colours as hsl strings for a swatch', () => {
    const swatch = logoPaletteSwatch('hsl(48 100% 40%)', 'dark')!;
    expect(swatch.highlight).toMatch(/^hsl\(/);
    expect(swatch.body).toMatch(/^hsl\(/);
  });

  test('is null without an accent: the caller draws the default metal', () => {
    expect(logoPaletteSwatch(null, 'dark')).toBeNull();
  });
});

describe('logoFrontColor', () => {
  test("is the palette's highlight, so dither and heatmap share one colour", () => {
    const accent = 'hsl(30 90% 55%)';
    for (const tone of ['light', 'dark'] as const) {
      expect(logoFrontColor(accent, tone)).toEqual(logoPaletteColors(accent, tone)!.first);
    }
    expect(logoFrontColor(null, 'dark')).toBeNull();
  });
});
