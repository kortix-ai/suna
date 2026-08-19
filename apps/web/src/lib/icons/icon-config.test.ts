import { describe, expect, test } from 'bun:test';

import { DEFAULT_ICON_WEIGHT, ICON_WEIGHTS } from './icon-config';

describe('icon-config', () => {
  test('exposes all six phosphor weights exactly once', () => {
    expect([...ICON_WEIGHTS].sort()).toEqual(
      ['bold', 'duotone', 'fill', 'light', 'regular', 'thin'].sort(),
    );
    expect(new Set(ICON_WEIGHTS).size).toBe(6);
  });

  test('default weight is one of the valid weights', () => {
    expect(ICON_WEIGHTS).toContain(DEFAULT_ICON_WEIGHT);
  });
});
