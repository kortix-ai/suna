import { describe, expect, test } from 'bun:test';

import { HERO_KEYBOARD_SCALE, heroLogoSize } from './project-hero';

describe('project hero logo', () => {
  test('is 30% of the window width on a phone', () => {
    expect(heroLogoSize(402)).toBe(121); // iPhone 17
    expect(heroLogoSize(375)).toBe(113);
  });

  test('never drops below 88pt or grows past 150pt', () => {
    expect(heroLogoSize(280)).toBe(88);
    expect(heroLogoSize(320)).toBe(96);
    expect(heroLogoSize(820)).toBe(150); // iPad
  });

  test('falls back to the minimum for a width that is not a positive number', () => {
    expect(heroLogoSize(0)).toBe(88);
    expect(heroLogoSize(Number.NaN)).toBe(88);
  });

  test('shrinks to 76pt beside the keyboard on a 402pt phone', () => {
    expect(heroLogoSize(402) * HERO_KEYBOARD_SCALE).toBeCloseTo(75.6, 1);
  });
});
