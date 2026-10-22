import { expect, test } from 'bun:test';
import { relativeTime } from './relative-time';
const now = Date.UTC(2026, 0, 15, 12);
test('relative-time adapters preserve narrow, long, zero and invalid labels', () => {
  expect(relativeTime(now - 120000, 'en', now)).toBe('2m ago');
  expect(relativeTime(now - 120000, 'en', now, { style: 'long', zero: 'minute' })).toBe(
    '2 minutes ago',
  );
  expect(relativeTime(now - 1000, 'en', now)).toBe('just now');
  expect(relativeTime(now - 1000, 'en', now, { zero: 'minute' })).toBe('this minute');
  expect(relativeTime('invalid', 'en', now)).toBe('');
  expect(relativeTime('invalid', 'en', now, { empty: '—' })).toBe('—');
  expect(relativeTime(now + 1000, 'en', now, { zero: 'minute' })).toBe('in 1m');
});

test('relative-time adapters preserve future countdown direction and style', () => {
  expect(relativeTime(now + 300000, 'en', now)).toBe('in 5m');
  expect(relativeTime(now + 86400000, 'en', now)).toBe('in 1d');
  expect(relativeTime(now + 300000, 'en', now, { style: 'long' })).toBe('in 5 minutes');
});
