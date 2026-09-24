import { describe, expect, test } from 'bun:test';
import { BUTTON_BOX, defaultButtonHitSlop, MIN_TOUCH_TARGET, slopToReach, type ButtonSize } from './hit-target';

describe('slopToReach', () => {
  test('grows a small box to 44pt', () => {
    expect(slopToReach(28)).toBe(8);
    expect(slopToReach(36)).toBe(4);
    expect(slopToReach(40)).toBe(2);
  });
  test('rounds up an odd gap', () => expect(slopToReach(33)).toBe(6));
  test('never negative', () => {
    expect(slopToReach(44)).toBe(0);
    expect(slopToReach(48)).toBe(0);
  });
});

describe('defaultButtonHitSlop', () => {
  test('icon sizes reach 44pt on both axes', () => {
    for (const size of ['icon', 'icon-md'] as const) {
      const slop = defaultButtonHitSlop(size)!;
      const box = BUTTON_BOX[size];
      expect(box.height + slop.top + slop.bottom).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(box.width + slop.left + slop.right).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });

  test('icon-sm is 44pt tall and stops short of a neighbour 2pt away', () => {
    const slop = defaultButtonHitSlop('icon-sm')!;
    expect(28 + slop.top + slop.bottom).toBe(44);
    expect(slop.left).toBe(4);
    expect(slop.right).toBe(4);
  });

  test('text sizes grow vertically only', () => {
    expect(defaultButtonHitSlop('default')).toEqual({ top: 2, bottom: 2, left: 0, right: 0 });
    expect(defaultButtonHitSlop('sm')).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
    expect(defaultButtonHitSlop(undefined)).toEqual(defaultButtonHitSlop('default'));
    expect(defaultButtonHitSlop(null)).toEqual(defaultButtonHitSlop('default'));
  });

  test('44pt and taller sizes need no slop', () => {
    expect(defaultButtonHitSlop('lg')).toBeUndefined();
    expect(defaultButtonHitSlop('xl')).toBeUndefined();
  });

  test('every size reaches 44pt tall', () => {
    for (const size of Object.keys(BUTTON_BOX) as ButtonSize[]) {
      const slop = defaultButtonHitSlop(size);
      expect(BUTTON_BOX[size].height + (slop ? slop.top + slop.bottom : 0)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });
});
