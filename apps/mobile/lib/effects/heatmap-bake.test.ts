import { describe, expect, test } from 'bun:test';
import { blurGray, packHeatmap, splitPlanes } from './heatmap-bake';

describe('blurGray', () => {
  test('radius 0 returns a copy', () => {
    const g = new Uint8ClampedArray([0, 255, 0, 255]);
    const out = blurGray(g, 2, 2, 0);
    expect(Array.from(out)).toEqual([0, 255, 0, 255]);
    expect(out).not.toBe(g);
  });
  test('uniform image stays uniform', () => {
    const g = new Uint8ClampedArray(25).fill(200);
    expect(Array.from(blurGray(g, 5, 5, 2)).every((v) => v === 200)).toBe(true);
  });
  test('single white pixel spreads over its 3x3 neighbourhood at radius 1', () => {
    const g = new Uint8ClampedArray(25);
    g[12] = 255;
    const out = blurGray(g, 5, 5, 1);
    expect(out[12]).toBe(Math.round(255 / 9));
    expect(out[0]).toBe(0);
  });
});

describe('packHeatmap', () => {
  test('alpha is 255 everywhere and the contour channel reacts to a dark pixel', () => {
    const g = new Uint8ClampedArray(16 * 16).fill(255);
    g[8 * 16 + 8] = 0;
    const px = packHeatmap(g, 16, 16, 100);
    expect(px.length).toBe(16 * 16 * 4);
    expect(px[3]).toBe(255);
    expect(px[(8 * 16 + 8) * 4]).toBeLessThan(255);
  });
});

describe('splitPlanes', () => {
  test('lays R, G, B side by side as one gray image, dropping alpha', () => {
    // 2x1 RGBA: pixel 0 = (10, 20, 30, 255), pixel 1 = (40, 50, 60, 255)
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    const atlas = splitPlanes(rgba, 2, 1);
    expect(Array.from(atlas)).toEqual([10, 40, 20, 50, 30, 60]);
  });
  test('atlas is 3 planes wide', () => {
    const atlas = splitPlanes(new Uint8ClampedArray(4 * 4 * 3 * 4), 4, 3);
    expect(atlas.length).toBe(3 * 4 * 3);
  });
});
