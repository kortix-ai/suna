/**
 * liquid-metal-bake — builds the texture Paper's LiquidMetal shader samples.
 *
 * Port of `toProcessedLiquidMetal` from `@paper-design/shaders` 0.0.81
 * (`dist/shaders/liquid-metal.js`). Paper runs it in a browser canvas at load
 * time; React Native has no such canvas, and the result never changes for one
 * SVG, so `scripts/bake-liquid-metal.ts` runs it once and commits the PNG.
 * The solver is unchanged (red-black SOR, omega 1.9, 40 iterations, source
 * term 0.01, on a 512 px working size): the shader's constants were tuned
 * against exactly this field.
 *
 * Channels in Paper's PNG: R = edge field (255 on the outline, falling towards
 * 0 in the middle of the shape, 255 outside), G = the shape's alpha, B = 255.
 *
 * Shipped as two gray planes side by side (`packPlanes`): edge | alpha. The
 * texture is data, not a picture, but Skia color-manages it like a picture, so
 * an RGB texture's channels mix on a wide-gamut display (see `heatmap-bake.ts`).
 * Neutral gray passes through unchanged. The dither style samples the alpha
 * plane of the same texture.
 *
 * Pure functions only: `bun test` cannot load native modules.
 */

/** Paper solves the field with the image's shorter side at this many pixels. */
export const WORKING_SIZE = 512;
/** Paper rasterises an SVG with its longer side at this many pixels. */
export const PAPER_SVG_SIZE = 4096;
export const ITERATIONS = 40;
const SOURCE = 0.01;
const OMEGA = 1.9;

/** 1 where the shape is (alpha > 0), else 0. */
export function shapeMaskFromAlpha(alpha: Uint8ClampedArray | Uint8Array): Uint8Array {
  const mask = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) mask[i] = alpha[i] === 0 ? 0 : 1;
  return mask;
}

/**
 * Splits the shape's pixels into boundary (an image edge or a non-shape
 * 8-neighbour) and interior. Paper's `toProcessedLiquidMetal`, unchanged.
 */
export function classifyShape(
  shapeMask: Uint8Array,
  width: number,
  height: number,
): { interior: Uint32Array; boundary: Uint32Array } {
  const interior: number[] = [];
  const boundary: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!shapeMask[idx]) continue;
      const isBoundary =
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        !shapeMask[idx - 1] ||
        !shapeMask[idx + 1] ||
        !shapeMask[idx - width] ||
        !shapeMask[idx + width] ||
        !shapeMask[idx - width - 1] ||
        !shapeMask[idx - width + 1] ||
        !shapeMask[idx + width - 1] ||
        !shapeMask[idx + width + 1];
      (isBoundary ? boundary : interior).push(idx);
    }
  }
  return { interior: new Uint32Array(interior), boundary: new Uint32Array(boundary) };
}

/**
 * Solves the Poisson equation (laplacian u = -SOURCE, u = 0 on the boundary)
 * over the interior pixels with red-black successive over-relaxation. Paper's
 * solver, unchanged: the same iteration count gives the same field.
 */
export function solvePoisson(
  shapeMask: Uint8Array,
  width: number,
  height: number,
  iterations = ITERATIONS,
): Float32Array {
  const { interior } = classifyShape(shapeMask, width, height);
  const count = interior.length;
  const neighbours = new Int32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const idx = interior[i]!;
    const x = idx % width;
    const y = Math.floor(idx / width);
    neighbours[i * 4] = x < width - 1 && shapeMask[idx + 1] ? idx + 1 : -1;
    neighbours[i * 4 + 1] = x > 0 && shapeMask[idx - 1] ? idx - 1 : -1;
    neighbours[i * 4 + 2] = y > 0 && shapeMask[idx - width] ? idx - width : -1;
    neighbours[i * 4 + 3] = y < height - 1 && shapeMask[idx + width] ? idx + width : -1;
  }
  const red: number[] = [];
  const black: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = interior[i]!;
    ((idx % width) + Math.floor(idx / width)) % 2 === 0 ? red.push(i) : black.push(i);
  }
  const u = new Float32Array(width * height);
  const relax = (i: number) => {
    const idx = interior[i]!;
    let sum = 0;
    for (let n = 0; n < 4; n++) {
      const j = neighbours[i * 4 + n]!;
      if (j >= 0) sum += u[j]!;
    }
    u[idx] = OMEGA * ((SOURCE + sum) / 4) + (1 - OMEGA) * u[idx]!;
  };
  for (let iter = 0; iter < iterations; iter++) {
    for (const i of red) relax(i);
    for (const i of black) relax(i);
  }
  return u;
}

/**
 * The edge field as a gray image: 255 outside the shape and on its outline,
 * down to 0 where the field peaks. Paper's `255 * (1 - u / max)`.
 */
export function edgeFieldToGray(u: Float32Array, shapeMask: Uint8Array): Uint8ClampedArray {
  let max = 0;
  for (let i = 0; i < u.length; i++) if (shapeMask[i] && u[i]! > max) max = u[i]!;
  const gray = new Uint8ClampedArray(u.length);
  for (let i = 0; i < u.length; i++) {
    gray[i] = shapeMask[i] ? 255 * (1 - (max > 0 ? u[i]! / max : 0)) : 255;
  }
  return gray;
}

/** Edge field for a shape mask at its own size: solve, then gray. */
export function bakeEdgeField(shapeMask: Uint8Array, width: number, height: number): Uint8ClampedArray {
  return edgeFieldToGray(solvePoisson(shapeMask, width, height), shapeMask);
}

/** Paper's working size for an image: the shorter side at `WORKING_SIZE`. */
export function workingSize(width: number, height: number): { width: number; height: number } {
  const scale = WORKING_SIZE / Math.min(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Two gray images of the same size -> one gray image with them side by side. */
export function packPlanes(
  planes: ReadonlyArray<Uint8ClampedArray | Uint8Array>,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * planes.length * height);
  for (let y = 0; y < height; y++) {
    for (let p = 0; p < planes.length; p++) {
      const plane = planes[p]!;
      const row = y * width * planes.length + p * width;
      for (let x = 0; x < width; x++) out[row + x] = plane[y * width + x] ?? 0;
    }
  }
  return out;
}
