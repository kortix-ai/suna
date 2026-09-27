import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DOT_MATRIX_CATALOG,
  SESSION_DOT_MATRIX_POOL,
  cubicBezier,
  dotMatrixLayout,
  remapOpacityToTriplet,
  sessionDotMatrixIndex,
  sessionDotMatrixVariant,
  type DotMatrixVariant,
} from './dot-matrix';

const WEB_CATALOG = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'web',
  'src',
  'components',
  'ui',
  'dot-matrix',
  'session-dot-matrix.tsx',
);

function variant(name: string): DotMatrixVariant {
  const found = DOT_MATRIX_CATALOG.find((entry) => entry.name === name);
  if (!found) throw new Error(`no variant ${name}`);
  return found;
}

function cell(grid: number, row: number, col: number): number {
  return row * grid + col;
}

describe('catalog (web session-dot-matrix.tsx)', () => {
  test('same names, same order, same families as web', () => {
    const source = readFileSync(WEB_CATALOG, 'utf8');
    const block = source.slice(source.indexOf('export const DOT_MATRIX_CATALOG'), source.indexOf('];'));
    const web = [...block.matchAll(/name: '([^']+)', family: '([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(web).toHaveLength(52);
    expect(DOT_MATRIX_CATALOG.map((entry) => `${entry.name}:${entry.family}`)).toEqual(web);
  });

  test('17 3x3, 15 circular, 20 square; pool is the whole catalog', () => {
    const count = (family: string) => DOT_MATRIX_CATALOG.filter((entry) => entry.family === family).length;
    expect([count('3x3'), count('circular'), count('square')]).toEqual([17, 15, 20]);
    expect(SESSION_DOT_MATRIX_POOL).toEqual(DOT_MATRIX_CATALOG);
  });
});

describe('sessionDotMatrixIndex (FNV-1a, web values)', () => {
  test('known ids map to the index web computes', () => {
    expect(sessionDotMatrixIndex('ses_0000000000000001')).toBe(0);
    expect(sessionDotMatrixIndex('ses_0000000000000002')).toBe(29);
    expect(sessionDotMatrixIndex('ses_0000000000000003')).toBe(2);
    expect(sessionDotMatrixIndex('0f7c2a1e-4b9d-4e8a-9c3d-000000000000')).toBe(10);
    expect(sessionDotMatrixIndex('a')).toBe(40);
  });

  test('no session id falls back to dotm-square-14', () => {
    expect(sessionDotMatrixVariant(undefined).name).toBe('dotm-square-14');
    expect(sessionDotMatrixVariant('a').name).toBe(DOT_MATRIX_CATALOG[40]!.name);
  });
});

describe('layout at the 14px indicator size', () => {
  test('5x5 families: 2px dots, 1px gap, 14px box', () => {
    expect(dotMatrixLayout(variant('dotm-circular-1'), 14)).toEqual({ grid: 5, span: 14, dotSize: 2, gap: 1, track: 2 });
    expect(dotMatrixLayout(variant('dotm-square-14'), 14)).toEqual({ grid: 5, span: 14, dotSize: 2, gap: 1, track: 2 });
  });

  test('3x3 family: default 3px dots, 1px padding, 11px box', () => {
    expect(dotMatrixLayout(variant('dotm-3x3-2'), 14)).toEqual({ grid: 3, span: 11, dotSize: 3, gap: 1, track: 3 });
  });
});

describe('opacity math (web dotmatrix-core.tsx)', () => {
  test('remapOpacityToTriplet without overrides only clamps', () => {
    expect(remapOpacityToTriplet(1.4, undefined)).toBe(1);
    expect(remapOpacityToTriplet(0.3, undefined)).toBe(0.3);
  });

  test('remapOpacityToTriplet with the 3x3 base override', () => {
    expect(remapOpacityToTriplet(0.08, 0.06)).toBeCloseTo(0.06, 6);
    expect(remapOpacityToTriplet(0.04, 0.06)).toBeCloseTo(0.03, 6);
    expect(remapOpacityToTriplet(0.09, 0.06)).toBeCloseTo(0.0707692, 6);
    expect(remapOpacityToTriplet(0.88, 0.06)).toBeCloseTo(0.88, 6);
  });

  test('cubicBezier', () => {
    const inOut = cubicBezier(0.42, 0, 0.58, 1);
    expect(inOut(0)).toBe(0);
    expect(inOut(1)).toBe(1);
    expect(inOut(0.5)).toBeCloseTo(0.5, 4);
    expect(cubicBezier(0, 0, 0.58, 1)(0.25)).toBeGreaterThan(0.25);
  });
});

describe('every variant renders a stable grid', () => {
  test('cell count, opacity range, and a hidden mask that never moves', () => {
    for (const entry of DOT_MATRIX_CATALOG) {
      const cells = entry.grid * entry.grid;
      const masks = [0, 17, 333, 1234, 9999].map((t) => entry.frame(t, false));
      masks.push(entry.frame(0, true));
      for (const frame of masks) {
        expect({ name: entry.name, length: frame.length }).toEqual({ name: entry.name, length: cells });
        for (const value of frame) {
          if (value === null) continue;
          expect({ name: entry.name, ok: Number.isFinite(value) && value >= 0 && value <= 1 }).toEqual({
            name: entry.name,
            ok: true,
          });
        }
        expect({ name: entry.name, hidden: frame.map((v) => v === null) }).toEqual({
          name: entry.name,
          hidden: masks[0]!.map((v) => v === null),
        });
      }
    }
  });

  test('circular variants hide the four corners; square-4 hides its centre', () => {
    for (const entry of DOT_MATRIX_CATALOG.filter((e) => e.family === 'circular')) {
      const frame = entry.frame(0, false);
      expect([frame[0], frame[4], frame[20], frame[24]]).toEqual([null, null, null, null]);
      expect(frame.filter((v) => v === null)).toHaveLength(4);
    }
    const square4 = variant('dotm-square-4').frame(500, false);
    expect(square4[cell(5, 2, 2)]).toBeNull();
    expect(square4.filter((v) => v === null)).toHaveLength(1);
  });
});

describe('reduced motion holds the web idle frame', () => {
  test('3x3 diagonal wave: path × 0.88, remapped', () => {
    const frame = variant('dotm-3x3-2').frame(0, true);
    expect(frame[cell(3, 0, 2)]).toBeCloseTo(0, 6);
    expect(frame[cell(3, 2, 0)]).toBeCloseTo(0.88, 6);
    expect(frame[cell(3, 1, 1)]).toBeCloseTo(0.44, 6);
  });

  test('3x3 glyph spin shows the unrotated glyph', () => {
    const frame = variant('dotm-3x3-16').frame(5000, true);
    expect(frame[0]).toBeCloseTo(0.88, 6);
    expect(frame[1]).toBeCloseTo(0.0707692, 6);
  });

  test('square spiral: 0.16 + path × 0.78', () => {
    const frame = variant('dotm-square-3').frame(0, true);
    expect(frame[cell(5, 0, 0)]).toBeCloseTo(0.16, 6);
    expect(frame[cell(5, 2, 2)]).toBeCloseTo(0.94, 6);
  });
});

describe('CSS keyframe variants follow the web stylesheet', () => {
  test('a dot waits out its animation-delay at the resting opacity', () => {
    // dmx-spiral-snake: order 0 starts at once, order 1 waits 0.04 cycles.
    const frame = variant('dotm-square-3').frame(0, false);
    expect(frame[cell(5, 0, 0)]).toBeCloseTo(0.08, 6); // 0.5 × base 0.16
    expect(frame[cell(5, 0, 1)]).toBeCloseTo(0.24, 6); // .dmx-dot 0.5 × (base + mid)
  });

  test('the spiral head peaks at 8% of the cycle', () => {
    const duration = 1500 / 1.35;
    expect(variant('dotm-square-3').frame(duration * 0.08, false)[cell(5, 0, 0)]).toBeCloseTo(1, 6);
  });

  test('steps(12, end) quantises each keyframe interval', () => {
    // dmx-circular2-ring: first interval 1 → 0.728 over 1/12 of 1500ms / 1.8.
    const interval = 1500 / 1.8 / 12;
    const frame = variant('dotm-circular-2').frame(interval * 0.52, false);
    expect(frame[cell(5, 0, 1)]).toBeCloseTo(0.864, 6);
  });
});

describe('JS-driven variants follow the web hooks', () => {
  test('square-13 compass: step 0 points north, step 2 north-east', () => {
    const v = variant('dotm-square-13');
    const n = v.frame(0, false);
    expect(n[cell(5, 0, 2)]).toBe(1);
    expect(n[cell(5, 2, 2)]).toBe(0.56);
    expect(n[cell(5, 4, 4)]).toBe(0.08);
    const stepMs = 1550 / 1.85 / 16;
    const ne = v.frame(stepMs * 2.5, false);
    expect(ne[cell(5, 0, 4)]).toBe(1);
    expect(ne[cell(5, 0, 2)]).toBe(0.08);
  });

  test('square-14 eases each frame change over 180ms', () => {
    const v = variant('dotm-square-14');
    const stepMs = 1700 / 1.25 / 6;
    const corner = cell(5, 0, 0);
    expect(v.frame(0, false)[corner]).toBe(1);
    expect(v.frame(stepMs + 1, false)[corner]).toBeGreaterThan(0.9);
    const mid = v.frame(stepMs + 90, false)[corner]!;
    expect(mid).toBeLessThan(0.9);
    expect(mid).toBeGreaterThan(0.08);
    expect(v.frame(stepMs + 181, false)[corner]).toBeCloseTo(0.08, 6);
  });

  test('glyph spin cycles through four quarter turns every 720ms at speed 1', () => {
    const v = variant('dotm-3x3-18');
    expect(v.frame(0, false)).toEqual(v.frame(720, false));
  });
});
