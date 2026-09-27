import { describe, expect, test } from 'bun:test';

import { DEFAULT_LOGO_STYLE_ID, LOGO_STYLES, LOGO_STYLE_COLORS, isLogoStyleId } from './logo-style';

describe('LOGO_STYLES', () => {
  test('the dither is first and the default; ids are unique', () => {
    expect(LOGO_STYLES[0]?.id).toBe('dither');
    expect(DEFAULT_LOGO_STYLE_ID).toBe('dither');
    const ids = LOGO_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['dither', 'heatmap']);
  });
  test('isLogoStyleId accepts each style and rejects anything else', () => {
    for (const style of LOGO_STYLES) expect(isLogoStyleId(style.id)).toBe(true);
    expect(isLogoStyleId('liquid')).toBe(false);
    expect(isLogoStyleId('metal')).toBe(false);
    expect(isLogoStyleId(undefined)).toBe(false);
  });
});

describe('LOGO_STYLE_COLORS', () => {
  test('both tones give the dither an opaque colour', () => {
    for (const tone of ['light', 'dark'] as const) {
      const rgba = LOGO_STYLE_COLORS[tone].dither.front;
      expect(rgba).toHaveLength(4);
      expect(rgba[3]).toBe(1);
    }
  });
  test('the dither cells are white on a dark page and near-black on a light page', () => {
    expect(LOGO_STYLE_COLORS.dark.dither.front).toEqual([1, 1, 1, 1]);
    expect(LOGO_STYLE_COLORS.light.dither.front[0]).toBeLessThan(0.2);
  });
});
