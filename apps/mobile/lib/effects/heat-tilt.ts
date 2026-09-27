/**
 * heat-tilt — turns device movement (tilt away from a baseline pose) into the two inputs the metallic-logo shader
 * needs: a direction (`angleDeg`) and how far the highlight has swept (`sweep`).
 *
 * Every function is a worklet: the frame loop calls them on the UI thread.
 * Pure functions only: `bun test` cannot load native modules.
 */

export const TILT_DEAD_ZONE_RAD = 0.02;
/** Movement away from the baseline pose that gives the full sweep: about 29 degrees. */
export const TILT_FULL_RAD = 0.5;

export function tiltToHeat(pitch: number, roll: number): { angleDeg: number; sweep: number } {
  'worklet';
  const magnitude = Math.hypot(pitch, roll);
  if (magnitude <= TILT_DEAD_ZONE_RAD) return { angleDeg: 0, sweep: 0 };
  const sweep = Math.min(1, (magnitude - TILT_DEAD_ZONE_RAD) / (TILT_FULL_RAD - TILT_DEAD_ZONE_RAD));
  const angleDeg = (Math.atan2(pitch, roll) * 180) / Math.PI;
  return { angleDeg, sweep };
}

/** Signed shortest rotation from `fromDeg` to `toDeg`, in (-180, 180]. */
export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
  'worklet';
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Exponential low-pass, frame-rate independent. `tauSec` is the time constant. */
export function smooth(prev: number, next: number, dtSec: number, tauSec: number): number {
  'worklet';
  if (dtSec <= 0) return prev;
  const k = 1 - Math.exp(-dtSec / tauSec);
  return prev + (next - prev) * k;
}
