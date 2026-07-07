/**
 * Pure, deterministic helpers for the Particle Assembly mark (Rauch-style hard
 * pixels). Kept free of the DOM/canvas so the core maths is reproducible and
 * unit-testable.
 */

/** mulberry32 — a fast, deterministic PRNG. Same seed → same [0, 1) stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Symmetric ease used for the intro materialize. */
export function easeInOutCubic(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Clamp a value into the [0, 1] range. */
export function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Linear interpolation from `a` to `b` by `t`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Sample a rasterised mark on a fixed grid, collecting the top-left of every
 * cell whose alpha clears `threshold`. `alphaAt` is injected so this stays pure
 * and testable (the caller supplies the canvas pixels). Produces the hard-pixel
 * home positions the particles snap to.
 */
export function samplePixelHomes(
  targetWidth: number,
  targetHeight: number,
  stride: number,
  alphaAt: (x: number, y: number) => number,
  threshold = 32,
): Array<{ x: number; y: number }> {
  const homes: Array<{ x: number; y: number }> = [];
  if (stride <= 0) return homes;
  for (let y = 0; y < targetHeight; y += stride) {
    for (let x = 0; x < targetWidth; x += stride) {
      if (alphaAt(x, y) > threshold) homes.push({ x, y });
    }
  }
  return homes;
}

/**
 * Breathing oscillation in [-1, 1] that drives a uniform expand/contract of the
 * whole mark (the caller scales it around the mark centre, so the shape stays
 * intact — no rippling distortion). Deterministic; guards a non-positive period.
 */
export function breathePulse(now: number, period: number): number {
  if (period <= 0) return 0;
  return Math.sin((now / period) * Math.PI * 2);
}
