import { describe, expect, test } from 'bun:test';
import { relativeMinutes } from './event-check-times';

const NOW = Date.parse('2026-10-19T04:00:00Z');

describe('relativeMinutes: when a Kortix check ran or runs', () => {
  test('past and future minutes, hours and days in the viewer locale; seconds read as now', () => {
    expect(relativeMinutes('2026-10-19T03:58:00Z', 'en', NOW)).toBe('2 min. ago');
    expect(relativeMinutes('2026-10-19T04:03:00Z', 'en', NOW)).toBe('in 3 min.');
    expect(relativeMinutes('2026-10-19T04:00:20Z', 'en', NOW)).toBe('now');
    expect(relativeMinutes('2026-10-19T01:00:00Z', 'en', NOW)).toBe('3 hr. ago');
    expect(relativeMinutes('2026-10-22T04:00:00Z', 'en', NOW)).toBe('in 3 days');
    expect(relativeMinutes('2026-10-19T04:05:00Z', 'de', NOW)).toBe('in 5 Min.');
    expect(relativeMinutes('not a time', 'en', NOW)).toBeNull();
  });
});
