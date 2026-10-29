import { describe, expect, test } from 'bun:test';
import type { ChromeConnection } from '@kortix/sdk';

import { chromeCounts, chromeDisplayNames, offlineLongerThan } from './chrome-names';

function chrome(over: Partial<ChromeConnection> & { id: string }): ChromeConnection {
  return {
    name: 'Chromium on macOS',
    brand: 'chromium',
    os: 'macOS',
    profileLabel: null,
    extensionVersion: '1.0.0',
    accessMode: 'always',
    tabScope: 'all',
    online: true,
    lastSeenAt: null,
    createdAt: '2026-10-12T12:00:00Z',
    activeSessions: [],
    ...over,
  };
}

describe('chromeDisplayNames', () => {
  test('a unique name stays', () => {
    const names = chromeDisplayNames([chrome({ id: 'a' }), chrome({ id: 'b', name: 'Work' })]);
    expect(names.get('a')).toBe('Chromium on macOS');
    expect(names.get('b')).toBe('Work');
  });
  test('a repeated name takes the profile label, else a count in list order', () => {
    const names = chromeDisplayNames([
      chrome({ id: 'a', profileLabel: 'Work' }),
      chrome({ id: 'b' }),
      chrome({ id: 'c' }),
    ]);
    expect(names.get('a')).toBe('Chromium on macOS · Work');
    expect(names.get('b')).toBe('Chromium on macOS #2');
    expect(names.get('c')).toBe('Chromium on macOS #3');
  });
});

describe('chromeCounts', () => {
  test('counts all and online', () => {
    expect(chromeCounts([chrome({ id: 'a' }), chrome({ id: 'b', online: false })])).toEqual({
      count: 2,
      online: 1,
    });
  });
});

describe('offlineLongerThan', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  test('a recent or missing timestamp is not "long"', () => {
    expect(offlineLongerThan('2026-10-12T11:59:00Z', 600_000, now)).toBe(false);
    expect(offlineLongerThan(null, 600_000, now)).toBe(false);
  });
  test('an old one is', () => {
    expect(offlineLongerThan('2026-10-12T11:00:00Z', 600_000, now)).toBe(true);
  });
});
