import { describe, test, expect } from 'bun:test';
import { chalkColors, type ChalkColors } from './chalk-colors';

const HSL_PATTERN = /^hsl\((\d+) (\d+)% (\d+)%\)$/;

function parseHsl(value: string): { hue: number; sat: number; light: number } {
  const match = value.match(HSL_PATTERN);
  if (!match) throw new Error(`Not an hsl string: ${value}`);
  return { hue: Number(match[1]), sat: Number(match[2]), light: Number(match[3]) };
}

describe('chalkColors', () => {
  test('returns background, foreground and border as hsl strings', () => {
    const colors = chalkColors('alice');
    expect(colors.background).toMatch(HSL_PATTERN);
    expect(colors.foreground).toMatch(HSL_PATTERN);
    expect(colors.border).toMatch(HSL_PATTERN);
  });

  test('is deterministic for the same label', () => {
    expect(chalkColors('kortix')).toEqual(chalkColors('kortix'));
  });

  test('produces different colors for different labels', () => {
    const a = chalkColors('alpha');
    const b = chalkColors('a totally different label');
    expect(a).not.toEqual(b);
  });

  test('handles an empty label without throwing', () => {
    const colors = chalkColors('');
    expect(colors.background).toMatch(HSL_PATTERN);
  });

  test('treats empty label the same as the question-mark fallback', () => {
    expect(chalkColors('')).toEqual(chalkColors('?'));
  });

  test('keeps hue within the 0 to 359 range', () => {
    const labels = ['a', 'bb', 'ccc', 'entity-42', 'long label here', 'Z'];
    for (const label of labels) {
      const { hue } = parseHsl(chalkColors(label).background);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  test('keeps the three variants on the same hue', () => {
    const colors = chalkColors('shared-hue');
    const bg = parseHsl(colors.background);
    const fg = parseHsl(colors.foreground);
    const border = parseHsl(colors.border);
    expect(fg.hue).toBe(bg.hue);
    expect(border.hue).toBe(bg.hue);
  });

  test('keeps background saturation between 35 and 46', () => {
    const labels = ['one', 'two', 'three', 'four', 'five', 'six'];
    for (const label of labels) {
      const { sat } = parseHsl(chalkColors(label).background);
      expect(sat).toBeGreaterThanOrEqual(35);
      expect(sat).toBeLessThanOrEqual(46);
    }
  });

  test('caps foreground saturation at 82', () => {
    const labels = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    for (const label of labels) {
      const { sat } = parseHsl(chalkColors(label).foreground);
      expect(sat).toBeLessThanOrEqual(82);
    }
  });

  test('uses a darker foreground lightness than background', () => {
    const colors: ChalkColors = chalkColors('contrast');
    const bg = parseHsl(colors.background);
    const fg = parseHsl(colors.foreground);
    expect(fg.light).toBeLessThan(bg.light);
  });
});
