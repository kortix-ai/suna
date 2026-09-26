/**
 * drawer-springs — the project drawer's open and close motion (`ProjectScreen`
 * passes it to `react-native-drawer-layout` through
 * `patches/react-native-drawer-layout+4.2.10.patch`: `openSpringConfig`,
 * `closeSpringConfig`).
 *
 * The library has one spring (stiffness 1000, damping 500, mass 3): 4.6×
 * overdamped, it covers 90% of the width only after ~1.1s — a crawl.
 *
 * A tap (the menu button, `open={…}`, the overlay) runs a TIMED animation on
 * the iOS sheet curve, `cubic-bezier(0.32, 0.72, 0, 1)` — Ionic's curve, the
 * one Vaul uses for its drawers (Jay, 2026-09-27: "smoother and faster"). It
 * starts fast (2.25× the mean speed, ~10% in the first frame — no jump, which
 * a spring launched at full speed had), reaches 90% at 37% of its duration,
 * and glides the rest of the way in:
 * - Open 420ms: 90% by ~154ms, 99% by ~302ms.
 *
 * The close is ease-out-quad over 320ms (~76% of the open), not the sheet
 * curve (Jay, 2026-09-27: "it instantly disappears"): on the close, the sheet
 * curve covered 80% of the width in ~88ms, five frames. ease-out-quad still
 * starts fast, with no ease-in, but spreads the travel out — 50% by ~90ms,
 * 80% by ~170ms, 99% by ~298ms.
 *
 * A swipe release keeps the spring, critically damped, with the finger's
 * velocity: the drawer follows the hand and stays interruptible.
 *
 * Pure data: the progress helpers are the unit-tested proof.
 */

export type CubicBezier = readonly [number, number, number, number];

/** Ionic's iOS sheet curve (Vaul's drawer easing). */
export const IOS_SHEET_EASING: CubicBezier = [0.32, 0.72, 0, 1];
/** ease-out-quad: the gentlest ease-out — a fast start, the travel spread out. */
export const EASE_OUT_QUAD: CubicBezier = [0.25, 0.46, 0.45, 0.94];

export interface DrawerSpring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** A spring for swipe releases, plus the timed curve every tap uses. */
export interface DrawerMotion extends DrawerSpring {
  timing: { duration: number; easing: CubicBezier };
}

export const DRAWER_OPEN: DrawerMotion = {
  stiffness: 300,
  damping: 2 * Math.sqrt(300),
  mass: 1,
  timing: { duration: 420, easing: IOS_SHEET_EASING },
};
export const DRAWER_CLOSE: DrawerMotion = {
  stiffness: 400,
  damping: 40,
  mass: 1,
  timing: { duration: 320, easing: EASE_OUT_QUAD },
};

/** A cubic-bezier easing's output at time fraction `x` (Newton's method on x(t)). */
export function cubicBezierProgress([x1, y1, x2, y2]: CubicBezier, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let t = x;
  for (let i = 0; i < 20; i++) {
    const err = ((ax * t + bx) * t + cx) * t - x;
    if (Math.abs(err) < 1e-7) break;
    const slope = (3 * ax * t + 2 * bx) * t + cx;
    t = Math.min(1, Math.max(0, t - err / (slope || 1e-6)));
  }
  return ((ay * t + by) * t + cy) * t;
}

/** When a timed curve reaches 80%, 90% and 99% (ms), and how far it gets in the first 16ms frame. */
export function timingProgressTimes(
  timing: DrawerMotion['timing'],
): { p80: number; p90: number; p99: number; firstFrame: number } {
  let p80 = NaN;
  let p90 = NaN;
  let p99 = NaN;
  for (let ms = 0; ms <= timing.duration; ms += 0.5) {
    const y = cubicBezierProgress(timing.easing, ms / timing.duration);
    if (Number.isNaN(p80) && y >= 0.8) p80 = ms;
    if (Number.isNaN(p90) && y >= 0.9) p90 = ms;
    if (Number.isNaN(p99) && y >= 0.99) p99 = ms;
  }
  return { p80, p90, p99, firstFrame: cubicBezierProgress(timing.easing, 16 / timing.duration) };
}

/**
 * A spring from rest over a unit travel: when it reaches 90% and 99% (ms), and
 * how far past the target it swings. Integrated at 0.1ms.
 */
export function springProgressTimes(spring: DrawerSpring): { p90: number; p99: number; overshoot: number } {
  const dt = 0.0001;
  let x = 0;
  let v = 0;
  let p90 = NaN;
  let p99 = NaN;
  let peak = 0;
  for (let step = 1; step <= 50_000; step++) {
    const a = (-spring.stiffness * (x - 1) - spring.damping * v) / spring.mass;
    v += a * dt;
    x += v * dt;
    peak = Math.max(peak, x);
    const ms = step * dt * 1000;
    if (Number.isNaN(p90) && x >= 0.9) p90 = ms;
    if (Number.isNaN(p99) && x >= 0.99) {
      p99 = ms;
      break;
    }
  }
  return { p90, p99, overshoot: Math.max(0, peak - 1) };
}
