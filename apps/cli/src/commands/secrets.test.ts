import { describe, expect, test } from 'bun:test';
import { describeLinkValidity } from './secrets.ts';

describe('describeLinkValidity', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');

  test('a 7-day link reads as days', () => {
    expect(describeLinkValidity('2026-08-14T12:00:00.000Z', now)).toBe('7 days');
  });

  test('sub-2-day windows read as hours, sub-2-hour as minutes', () => {
    expect(describeLinkValidity('2026-08-08T00:00:00.000Z', now)).toBe('12 hours');
    expect(describeLinkValidity('2026-08-07T12:45:00.000Z', now)).toBe('45 minutes');
  });

  test('past or unparseable expiry degrades without lying', () => {
    expect(describeLinkValidity('2026-08-07T11:00:00.000Z', now)).toBe('an unknown window');
    expect(describeLinkValidity('garbage', now)).toBe('an unknown window');
  });
});
