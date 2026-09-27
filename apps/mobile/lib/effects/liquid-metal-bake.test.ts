import { describe, expect, test } from 'bun:test';

import {
  bakeEdgeField,
  classifyShape,
  edgeFieldToGray,
  packPlanes,
  shapeMaskFromAlpha,
  solvePoisson,
  workingSize,
} from './liquid-metal-bake';

/** A w x h mask with a filled rectangle. */
function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

describe('shapeMaskFromAlpha', () => {
  test('any non-zero alpha is shape', () => {
    expect(Array.from(shapeMaskFromAlpha(new Uint8ClampedArray([0, 1, 128, 255])))).toEqual([0, 1, 1, 1]);
  });
});

describe('classifyShape', () => {
  test('a 5x5 square in a 7x7 image: the outer ring is boundary, the 3x3 core interior', () => {
    const { interior, boundary } = classifyShape(rect(7, 7, 1, 1, 6, 6), 7, 7);
    expect(boundary.length).toBe(16);
    expect(interior.length).toBe(9);
    expect(Array.from(interior)).toContain(3 * 7 + 3);
  });
  test('a shape touching the image edge is boundary there', () => {
    const { interior } = classifyShape(rect(3, 3, 0, 0, 3, 3), 3, 3);
    expect(Array.from(interior)).toEqual([4]);
  });
});

describe('solvePoisson', () => {
  test('is zero on the boundary and outside, positive inside, and peaks at the centre', () => {
    const w = 21;
    const mask = rect(w, w, 2, 2, 19, 19);
    const u = solvePoisson(mask, w, w);
    expect(u[0]).toBe(0);
    expect(u[2 * w + 2]).toBe(0);
    const centre = u[10 * w + 10]!;
    const nearEdge = u[3 * w + 10]!;
    expect(centre).toBeGreaterThan(nearEdge);
    expect(nearEdge).toBeGreaterThan(0);
  });
  test('more iterations move the field towards the converged solution', () => {
    const w = 21;
    const mask = rect(w, w, 2, 2, 19, 19);
    const a = solvePoisson(mask, w, w, 5)[10 * w + 10]!;
    const b = solvePoisson(mask, w, w, 40)[10 * w + 10]!;
    const c = solvePoisson(mask, w, w, 400)[10 * w + 10]!;
    expect(Math.abs(c - b)).toBeLessThan(Math.abs(c - a));
  });
});

describe('edgeFieldToGray', () => {
  test('outside and outline are 255, the peak is 0', () => {
    const w = 21;
    const mask = rect(w, w, 2, 2, 19, 19);
    const gray = edgeFieldToGray(solvePoisson(mask, w, w), mask);
    expect(gray[0]).toBe(255);
    expect(gray[2 * w + 2]).toBe(255);
    expect(gray[10 * w + 10]).toBe(0);
    expect(bakeEdgeField(mask, w, w)[10 * w + 10]).toBe(0);
  });
  test('an empty mask is all 255', () => {
    const mask = new Uint8Array(9);
    expect(Array.from(edgeFieldToGray(new Float32Array(9), mask)).every((v) => v === 255)).toBe(true);
  });
});

describe('workingSize', () => {
  test("Paper's SVG raster (4096 x 3413) works at 614 x 512", () => {
    expect(workingSize(4096, 3413)).toEqual({ width: 614, height: 512 });
  });
  test('a portrait image scales its width', () => {
    expect(workingSize(1000, 2000)).toEqual({ width: 512, height: 1024 });
  });
});

describe('packPlanes', () => {
  test('lays planes side by side row by row', () => {
    const a = new Uint8ClampedArray([1, 2, 3, 4]);
    const b = new Uint8ClampedArray([5, 6, 7, 8]);
    expect(Array.from(packPlanes([a, b], 2, 2))).toEqual([1, 2, 5, 6, 3, 4, 7, 8]);
  });
});
