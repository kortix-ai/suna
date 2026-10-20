import { describe, expect, test } from 'bun:test';
import { supportsLiquidGlass } from './liquid-glass';

describe('supportsLiquidGlass', () => {
  test('iOS 26 and later with the ExpoUI module draw glass', () => {
    expect(supportsLiquidGlass('ios', '26.0', true)).toBe(true);
    expect(supportsLiquidGlass('ios', '26.5.1', true)).toBe(true);
    expect(supportsLiquidGlass('ios', '27.0', true)).toBe(true);
  });

  test('iOS before 26 keeps the opaque surface', () => {
    expect(supportsLiquidGlass('ios', '18.6', true)).toBe(false);
    expect(supportsLiquidGlass('ios', '17.0', true)).toBe(false);
  });

  test('a binary without the ExpoUI module keeps the opaque surface', () => {
    expect(supportsLiquidGlass('ios', '26.0', false)).toBe(false);
  });

  test('Android never draws glass', () => {
    expect(supportsLiquidGlass('android', 36, true)).toBe(false);
  });

  test('an unreadable version keeps the opaque surface', () => {
    expect(supportsLiquidGlass('ios', '', true)).toBe(false);
  });
});
