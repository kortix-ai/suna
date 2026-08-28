import { describe, expect, test } from 'bun:test';

import { isSliderAtDefault } from './agent-editor-basics-fields';

/**
 * "Reset" on a slider row unsets the key. It appeared for any value the key
 * held, so dragging Temperature away and back to 0 left a Reset link under a
 * slider that looked untouched — a control offering to undo nothing.
 */
describe('isSliderAtDefault', () => {
  test('an absent key is the default — it inherits', () => {
    expect(isSliderAtDefault(undefined, 0)).toBe(true);
    expect(isSliderAtDefault(undefined, 1)).toBe(true);
  });

  test('an explicit value equal to the parked one is also the default', () => {
    // Temperature parks at 0, Top-p parks at 1 — the reported case.
    expect(isSliderAtDefault(0, 0)).toBe(true);
    expect(isSliderAtDefault(1, 1)).toBe(true);
  });

  test('float drift from a fractional step still counts as the default', () => {
    // step=0.05 and step=0.01 do not land on exact binary fractions; six
    // additions of 0.05 give 0.30000000000000004, and coming back down can
    // leave a residue instead of a clean 0.
    expect(isSliderAtDefault(0.1 + 0.2 - 0.30000000000000004, 0)).toBe(true);
    expect(isSliderAtDefault(1 - Number.EPSILON, 1)).toBe(true);
  });

  test('a value the user actually chose is not the default', () => {
    expect(isSliderAtDefault(0.05, 0)).toBe(false);
    expect(isSliderAtDefault(2, 0)).toBe(false);
    expect(isSliderAtDefault(0.99, 1)).toBe(false);
    expect(isSliderAtDefault(0, 1)).toBe(false);
  });
});
