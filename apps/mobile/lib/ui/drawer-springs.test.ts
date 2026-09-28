import { describe, expect, test } from 'bun:test';

import {
  DRAWER_CLOSE,
  DRAWER_OPEN,
  EASE_OUT_QUAD,
  IOS_SHEET_EASING,
  cubicBezierProgress,
  springProgressTimes,
  timingProgressTimes,
  type DrawerSpring,
} from './drawer-springs';

/** The library's own spring, the one every open used before (Jay, 2026-09-27). */
const LIBRARY_SPRING: DrawerSpring = { stiffness: 1000, damping: 500, mass: 3 };

describe('cubicBezierProgress', () => {
  test('ends at 0 and 1, and the iOS sheet curve is past halfway at 16% of the time', () => {
    expect(cubicBezierProgress(IOS_SHEET_EASING, 0)).toBeCloseTo(0, 5);
    expect(cubicBezierProgress(IOS_SHEET_EASING, 1)).toBeCloseTo(1, 5);
    expect(cubicBezierProgress(IOS_SHEET_EASING, 0.162)).toBeGreaterThan(0.5);
  });
});

describe('drawer motion', () => {
  test('the library spring crawls: 90% of the travel takes over a second', () => {
    expect(springProgressTimes(LIBRARY_SPRING).p90).toBeGreaterThan(1000);
  });

  test('open: the iOS sheet curve — 90% by ~155ms, then a soft glide in', () => {
    const t = timingProgressTimes(DRAWER_OPEN.timing);
    expect(t.p90).toBeGreaterThan(140);
    expect(t.p90).toBeLessThan(170);
    expect(t.p99).toBeLessThan(320);
    // A fast start without a jump: ~10% in the first 16ms frame.
    expect(t.firstFrame).toBeGreaterThan(0.07);
    expect(t.firstFrame).toBeLessThan(0.15);
  });

  test('close is shorter than open: an exit at ~76% of the enter', () => {
    const ratio = DRAWER_CLOSE.timing.duration / DRAWER_OPEN.timing.duration;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.85);
  });

  test('close glides out instead of vanishing: 80% takes ~170ms, not ~90ms', () => {
    // The iOS sheet curve on the close covered 80% of the width in ~88ms —
    // five frames, read as "it just disappears" (Jay, 2026-09-27).
    const before = timingProgressTimes({ duration: 340, easing: IOS_SHEET_EASING });
    const now = timingProgressTimes(DRAWER_CLOSE.timing);
    expect(DRAWER_CLOSE.timing.easing).toEqual(EASE_OUT_QUAD);
    expect(before.p80).toBeLessThan(100);
    expect(now.p80).toBeGreaterThan(150);
    // Still quick: done (99%) before ~300ms, and no slow ease-in start.
    expect(now.p99).toBeLessThan(310);
    expect(now.firstFrame).toBeGreaterThan(0.05);
  });

  test('a swipe release keeps a critically damped spring: no overshoot', () => {
    for (const motion of [DRAWER_OPEN, DRAWER_CLOSE]) {
      const { stiffness, damping, mass } = motion;
      expect(damping).toBeCloseTo(2 * Math.sqrt(stiffness * mass), 0);
      expect(springProgressTimes(motion).overshoot).toBeLessThan(0.001);
    }
  });
});
