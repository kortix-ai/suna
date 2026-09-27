import { describe, expect, test } from 'bun:test';
import { accentColor, accentSoft, KORTIX_BLUE_HSL } from './accent';

describe('accent', () => {
  test('token value', () => expect(KORTIX_BLUE_HSL).toBe('210 93% 56.9%'));
  test('solid', () => expect(accentColor()).toBe('hsl(210 93% 56.9%)'));
  test('soft light', () => expect(accentSoft(false)).toBe('hsl(210 93% 56.9% / 0.10)'));
  test('soft dark', () => expect(accentSoft(true)).toBe('hsl(210 93% 56.9% / 0.12)'));
});
