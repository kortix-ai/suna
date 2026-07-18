import { describe, expect, it } from 'bun:test';
import { formatDate, formatDateTime, relativeTime } from './date';

describe('date utils', () => {
  it('formats a date as short month/day/year', () => {
    expect(formatDate('2026-07-04T12:00:00Z')).toBe('Jul 4, 2026');
  });
  it('returns empty string for nullish input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(relativeTime(null)).toBe('');
  });
  it('formats recent timestamps relatively', () => {
    expect(relativeTime(Date.now() - 30_000)).toBe('just now');
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
});
