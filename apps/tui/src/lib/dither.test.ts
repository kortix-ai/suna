import { describe, expect, test } from 'bun:test';

import { brailleBitsAt, ditherBand, fbm, toBraille } from './dither.ts';

describe('fbm', () => {
  test('is deterministic and stays in [0, 1)', () => {
    expect(fbm(1.3, 2.7, 0.4)).toBe(fbm(1.3, 2.7, 0.4));
    for (let i = 0; i < 200; i += 1) {
      const v = fbm(i * 0.37, i * 0.11, i * 0.05);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('ditherBand', () => {
  test('same time, same dots; another time, other dots', () => {
    const a = ditherBand(240, 12, 4);
    expect(ditherBand(240, 12, 4)).toEqual(a);
    expect(ditherBand(240, 12, 30)).not.toEqual(a);
  });

  test('dense at the top edge, fading out downward, empty in the bottom tenth', () => {
    const width = 240;
    const height = 32;
    const dots = ditherBand(width, height, 4);
    const row = (y: number) =>
      dots.slice(y * width, (y + 1) * width).reduce((sum, v) => sum + v, 0);
    expect(row(0)).toBeGreaterThan(width * 0.4);
    expect(row(height / 2)).toBeLessThan(row(0) / 2);
    expect(row(height - 1)).toBe(0);
  });

  test('an empty band has no dots', () => {
    expect(ditherBand(0, 12, 4).length).toBe(0);
  });
});

describe('toBraille', () => {
  test('encodes known patterns', () => {
    const full = new Uint8Array(2 * 4).fill(1);
    expect(toBraille(full, 1, 1)).toEqual(['⣿']);
    const one = (x: number, y: number) => {
      const dots = new Uint8Array(4 * 4);
      dots[y * 4 + x] = 1;
      return toBraille(dots, 2, 1)[0];
    };
    expect(one(0, 0)).toBe('⠁ ');
    expect(one(1, 3)).toBe('⢀ ');
    expect(one(0, 3)).toBe('⡀ ');
    expect(one(2, 1)).toBe(' ⠂');
    expect(toBraille(new Uint8Array(8), 1, 1)).toEqual([' ']);
  });

  test('reads an odd last column as the left dot column only', () => {
    expect(brailleBitsAt(new Uint8Array([1, 1, 1]), 3, 1, 0)).toBe(0x01);
  });
});
