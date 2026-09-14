import { afterEach, describe, expect, test } from 'bun:test';

import {
  IDENTITY_SCALAR,
  emojiConfettiShape,
  glyphConfettiShape,
  initialConfettiShape,
} from './confetti-shapes';

const CHALK = { background: 'hsl(1 2% 3%)', foreground: 'hsl(4 5% 6%)', border: 'hsl(7 8% 9%)' };
const SQUARE = 'M0,0 H256 V256 H0 Z';

/**
 * The two globals every builder gates on. Bun has neither, which is what makes
 * the degradation half of this file testable for free — and why the geometry
 * half has to install stubs.
 *
 * Restored on EVERY test, not just at the end of the file: `pnpm test` runs
 * bun test files in one process with no `--isolate`, so a global left behind
 * here is a global every later file inherits.
 */
function installCanvasStubs() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {
      measureText: () => ({ actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 1 }),
      canvas: null,
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        if (key in target) return target[key];
        return (...args: unknown[]) => calls.push(`${key}(${args.join(',')})`);
      },
      set(target, key: string, value) {
        calls.push(`${key}=${String(value)}`);
        target[key] = value;
        return true;
      },
    },
  );

  const bitmaps: Array<{ width: number; height: number }> = [];

  class StubOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return ctx;
    }
    transferToImageBitmap() {
      const bitmap = { width: this.width, height: this.height };
      bitmaps.push(bitmap);
      return bitmap;
    }
  }

  class StubPath2D {
    constructor(public d: string) {}
  }

  const globals = globalThis as Record<string, unknown>;
  globals.OffscreenCanvas = StubOffscreenCanvas;
  globals.Path2D = StubPath2D;

  return { calls, bitmaps };
}

afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals.OffscreenCanvas;
  delete globals.Path2D;
});

describe('degrading without OffscreenCanvas', () => {
  // The contract the callers depend on: `null`, never a throw. A browser that
  // cannot build an identity shape still gets a burst — canvas-confetti's own
  // squares and circles — because `identity-confetti.tsx` passes `undefined`
  // for `shapes` rather than an empty array.
  test('every builder returns null instead of throwing', () => {
    expect(emojiConfettiShape('🐢')).toBeNull();
    expect(glyphConfettiShape(SQUARE, 'rgb(1, 2, 3)')).toBeNull();
    expect(initialConfettiShape('T', CHALK, 'Roobert')).toBeNull();
  });
});

describe('particle geometry', () => {
  /**
   * `canvas-confetti` renders a bitmap shape as a pattern under
   * `new DOMMatrix(shape.matrix)` and draws plain confetti at ~10 canvas
   * units. `shapeFromText` hits that by rendering at `10 * scalar` and scaling
   * by `1 / scalar`. These builders render `RESOLUTION`x larger for texture,
   * so the ONLY thing that must hold is that `size * scale` still lands on 10
   * — otherwise an icon particle is a different size from the square beside it.
   */
  test('a glyph particle resolves to 10 canvas units, whatever the texture size', () => {
    const { bitmaps } = installCanvasStubs();
    const shape = glyphConfettiShape(SQUARE, 'rgb(1, 2, 3)');

    expect(shape).not.toBeNull();
    const matrix = shape as unknown as { type: string; matrix: number[] };
    expect(matrix.type).toBe('bitmap');

    const [scaleX, , , scaleY, translateX, translateY] = matrix.matrix;
    const size = bitmaps[0]!.width;

    expect(size * scaleX).toBeCloseTo(10, 10);
    expect(scaleY).toBe(scaleX);
    // Centred on the particle's own middle, so rotation spins the icon about
    // itself rather than swinging it around a corner.
    expect(translateX).toBeCloseTo(-5, 10);
    expect(translateY).toBeCloseTo(-5, 10);
  });

  test('an initial tile is built at the same size as a glyph, so neither dominates', () => {
    const glyph = installCanvasStubs();
    glyphConfettiShape(SQUARE, 'rgb(1, 2, 3)');
    const glyphSize = glyph.bitmaps[0]!.width;

    const initial = installCanvasStubs();
    initialConfettiShape('T', CHALK, 'Roobert');

    expect(initial.bitmaps[0]!.width).toBe(glyphSize);
    expect(initial.bitmaps[0]!.height).toBe(glyphSize);
  });

  test('the texture is square and a whole multiple of the scalar', () => {
    const { bitmaps } = installCanvasStubs();
    glyphConfettiShape(SQUARE, 'rgb(1, 2, 3)');

    const size = bitmaps[0]!.width;
    expect(size).toBe(bitmaps[0]!.height);
    expect(size % (10 * IDENTITY_SCALAR)).toBe(0);
  });
});

describe('painting', () => {
  test('an unparseable glyph colour leaves the seeded black behind, not a crash', () => {
    const { calls } = installCanvasStubs();
    glyphConfettiShape(SQUARE, 'not-a-colour');

    // Black FIRST, then the caller's value: assigning an invalid colour to a
    // real canvas is a no-op, so the seed IS the fallback. Order is the whole
    // mechanism — reversed, an invalid colour would paint nothing recognisable.
    expect(calls.indexOf('fillStyle=#000000')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('fillStyle=not-a-colour')).toBeGreaterThan(
      calls.indexOf('fillStyle=#000000'),
    );
  });

  test('the glyph is scaled from Phosphor’s 256 viewBox onto the texture', () => {
    const { calls, bitmaps } = installCanvasStubs();
    glyphConfettiShape(SQUARE, 'rgb(1, 2, 3)');

    const ratio = bitmaps[0]!.width / 256;
    expect(calls).toContain(`scale(${ratio},${ratio})`);
  });

  test('the initial tile paints fill, border and letter — the avatar’s three parts', () => {
    const { calls } = installCanvasStubs();
    initialConfettiShape('T', CHALK, 'Roobert');

    expect(calls).toContain(`fillStyle=${CHALK.background}`);
    expect(calls).toContain(`strokeStyle=${CHALK.border}`);
    expect(calls).toContain(`fillStyle=${CHALK.foreground}`);
    expect(calls.some((call) => call.startsWith('roundRect('))).toBe(true);
    expect(calls.some((call) => call.startsWith('fillText(T,'))).toBe(true);
  });

  test('the letter is set in the font family it is handed, not a canvas default', () => {
    const { calls } = installCanvasStubs();
    initialConfettiShape('T', CHALK, 'Roobert, sans-serif');

    expect(
      calls.some((call) => call.startsWith('font=') && call.endsWith('Roobert, sans-serif')),
    ).toBe(true);
  });
});
