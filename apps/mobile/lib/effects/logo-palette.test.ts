import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_LOGO_PALETTE_ID,
  LOGO_PALETTES,
  LOGO_PALETTE_GROUPS,
  hslToRgba,
  isLogoPaletteId,
  logoPaletteColors,
  logoPaletteSwatch,
} from './logo-palette';

describe('LOGO_PALETTES', () => {
  test('starts with the default metal, which has no accent', () => {
    expect(LOGO_PALETTES[0]).toEqual({
      id: 'default',
      label: 'Graphite',
      accent: null,
      finish: 'metal',
    });
    expect(DEFAULT_LOGO_PALETTE_ID).toBe('default');
  });

  test('every other palette names a brand accent, and ids are unique', () => {
    const ids = LOGO_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const palette of LOGO_PALETTES.slice(1)) expect(palette.accent).not.toBeNull();
  });

  test('is two groups for the picker: Metal, then Pastel, one pastel per accent', () => {
    expect(LOGO_PALETTE_GROUPS.map((g) => g.title)).toEqual(['Metal', 'Pastel']);
    expect(LOGO_PALETTE_GROUPS.flatMap((g) => g.palettes.map((p) => p.id))).toEqual(
      LOGO_PALETTES.map((p) => p.id)
    );
    const [metal, pastel] = LOGO_PALETTE_GROUPS;
    expect(metal.palettes.every((p) => p.finish === 'metal')).toBe(true);
    expect(pastel.palettes.every((p) => p.finish === 'pastel')).toBe(true);
    expect(pastel.palettes.map((p) => p.accent).sort()).toEqual(
      metal.palettes.flatMap((p) => (p.accent ? [p.accent] : [])).sort()
    );
  });
});

describe('isLogoPaletteId', () => {
  test('accepts a listed id and rejects anything else', () => {
    expect(isLogoPaletteId('gold')).toBe(true);
    expect(isLogoPaletteId('mint')).toBe(true);
    expect(isLogoPaletteId('default')).toBe(true);
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
    expect(logoPaletteColors(null, 'dark', 'metal')).toBeNull();
    expect(logoPaletteColors(null, 'light', 'metal')).toBeNull();
  });

  test('dark: a bright highlight over a dark body, as the default metal has', () => {
    const colors = logoPaletteColors(blue, 'dark', 'metal')!;
    expect(luminance(colors.first)).toBeGreaterThan(0.5);
    // The default metal's body is 0.141 grey: a palette's body is as dark.
    expect(luminance(colors.second)).toBeLessThan(0.2);
  });

  test('light: a dark outline over a light body, so it shows on a white page', () => {
    const colors = logoPaletteColors(blue, 'light', 'metal')!;
    expect(luminance(colors.first)).toBeLessThan(0.25);
    expect(luminance(colors.second)).toBeGreaterThan(0.6);
  });

  test('keeps the accent hue: blue stays blue', () => {
    const [r, , b] = logoPaletteColors(blue, 'dark', 'metal')!.first;
    expect(b).toBeGreaterThan(r);
  });

  test('pastel: a softer, lighter body than the metal of the same accent, on both pages', () => {
    for (const tone of ['dark', 'light'] as const) {
      const metal = logoPaletteColors(blue, tone, 'metal')!;
      const pastel = logoPaletteColors(blue, tone, 'pastel')!;
      expect(luminance(pastel.second)).toBeGreaterThanOrEqual(luminance(metal.second));
      expect(pastel).not.toEqual(metal);
    }
    // On a white page the outline must still show: the shader maps low heat to transparent.
    expect(luminance(logoPaletteColors(blue, 'light', 'pastel')!.first)).toBeLessThan(0.5);
  });

  test('rejects a string that is not a THEME hsl colour', () => {
    expect(() => logoPaletteColors('#ff0000', 'dark', 'metal')).toThrow();
  });
});

describe('logoPaletteSwatch', () => {
  test('gives the two colours as hsl strings for a swatch', () => {
    const swatch = logoPaletteSwatch('hsl(48 100% 40%)', 'dark', 'pastel')!;
    expect(swatch.highlight).toMatch(/^hsl\(/);
    expect(swatch.body).toMatch(/^hsl\(/);
  });

  test('is null without an accent: the caller draws the default metal', () => {
    expect(logoPaletteSwatch(null, 'dark', 'metal')).toBeNull();
  });
});
