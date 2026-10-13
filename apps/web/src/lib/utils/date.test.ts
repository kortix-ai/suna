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
  it('renders a future timestamp as its countdown, not as "just now"', () => {
    // A key expiring in a day is not fresh — it has not happened yet.
    expect(relativeTime(Date.now() + 5 * 60_000)).toBe('in 5m');
    expect(relativeTime(Date.now() + 23 * 3600_000)).toBe('in 23h');
    expect(relativeTime(Date.now() + 24 * 3600_000)).toBe('in 1d');
  });
});
