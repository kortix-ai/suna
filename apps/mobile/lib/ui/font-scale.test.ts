import { describe, expect, test } from 'bun:test';
import { BUTTON_LABEL_MAX_FONT_SCALE, maxFontScaleForBox } from './font-scale';

describe('maxFontScaleForBox', () => {
  test('scale at which the line fills the box, floored to 0.05', () => {
    expect(maxFontScaleForBox(36, 20)).toBe(1.8);
    expect(maxFontScaleForBox(44, 24)).toBe(1.8);
    expect(maxFontScaleForBox(40, 20)).toBe(2);
  });
  test('never below 1: the default size is never shrunk', () => {
    expect(maxFontScaleForBox(16, 20)).toBe(1);
  });
  test('the capped line never exceeds the box', () => {
    for (const [box, line] of [[36, 20], [44, 24], [48, 24], [33, 17]] as const) {
      expect(line * maxFontScaleForBox(box, line)).toBeLessThanOrEqual(box);
    }
  });
});

describe('BUTTON_LABEL_MAX_FONT_SCALE', () => {
  test('per Button size', () => {
    expect(BUTTON_LABEL_MAX_FONT_SCALE).toEqual({ sm: 1.8, default: 2, lg: 1.8, xl: 2 });
  });
});
