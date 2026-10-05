import { describe, expect, test } from 'bun:test';

import { relativeAge } from './relative-time.ts';

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const minutes = (n: number) => NOW - n * 60_000;
const hours = (n: number) => NOW - n * 3_600_000;
const days = (n: number) => NOW - n * 86_400_000;

describe('relativeAge', () => {
  test('under a minute reads `now`', () => {
    expect(relativeAge(NOW, NOW)).toBe('now');
    expect(relativeAge(NOW - 59_000, NOW)).toBe('now');
  });

  test('minutes, hours and days each get their own unit', () => {
    expect(relativeAge(minutes(1), NOW)).toBe('1m');
    expect(relativeAge(minutes(59), NOW)).toBe('59m');
    expect(relativeAge(hours(1), NOW)).toBe('1h');
    expect(relativeAge(hours(23), NOW)).toBe('23h');
    expect(relativeAge(days(1), NOW)).toBe('1d');
    expect(relativeAge(days(29), NOW)).toBe('29d');
  });

  test('months and years bucket the long tail', () => {
    expect(relativeAge(days(30), NOW)).toBe('1mo');
    expect(relativeAge(days(364), NOW)).toBe('12mo');
    expect(relativeAge(days(365), NOW)).toBe('1y');
    expect(relativeAge(days(900), NOW)).toBe('2y');
  });

  test('never prints more than four columns', () => {
    for (const ms of [NOW, minutes(7), hours(9), days(3), days(200), days(4000)]) {
      expect(relativeAge(ms, NOW).length).toBeLessThanOrEqual(4);
    }
  });

  test('a future timestamp reads `now`, not a negative age', () => {
    expect(relativeAge(NOW + 90_000, NOW)).toBe('now');
  });

  test('an unparseable timestamp renders nothing', () => {
    expect(relativeAge(Number.NaN, NOW)).toBe('');
  });
});
