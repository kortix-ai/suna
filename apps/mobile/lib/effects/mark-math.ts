/**
 * Pure geometry for the Kortix mark effects — the mobile twin of
 * `apps/web/src/features/mark-effects/mark-math.ts`. Keep the two in sync: the
 * constants and `flowAngle` define the shared look of the effect on both
 * platforms.
 *
 * Everything here is a worklet so the particle simulation can run on the UI
 * thread. No Skia, no React — just maths, so it stays deterministic.
 *
 * The path is the Kortix *symbol* (the 30×25 brandmark), never the wordmark.
 */

export const KORTIX_SYMBOL_PATH =
  'M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z';

export const SYMBOL_WIDTH = 30;
export const SYMBOL_HEIGHT = 25;
export const SYMBOL_ASPECT = SYMBOL_WIDTH / SYMBOL_HEIGHT;

export function clamp(value: number, min: number, max: number): number {
  'worklet';
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clamp01(value: number): number {
  'worklet';
  return clamp(value, 0, 1);
}

/**
 * A smooth, seamless pseudo-curl angle field — layered sines/cosines rather
 * than a noise table, so it stays deterministic while particles drift
 * coherently. `t` is a slow time term.
 */
export function flowAngle(x: number, y: number, t: number): number {
  'worklet';
  return (
    (Math.sin(x * 0.0075 + t) +
      Math.cos(y * 0.0075 - t * 0.8) +
      Math.sin((x + y) * 0.006 + t * 0.5)) *
    (Math.PI / 1.5)
  );
}
