import { describe, expect, test } from 'bun:test';
import { CHANNEL_PLATFORM_IDS, CHANNELS, isChannelPlatform } from './channel-descriptors';

const descriptors = CHANNEL_PLATFORM_IDS.map((id) => CHANNELS[id]);
const regexps = (value: unknown): RegExp[] =>
  value instanceof RegExp ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(regexps) : [];

describe('channel descriptors', () => {
  test('labels and envelope words are unique', () => {
    for (const key of ['label', 'envelope'] as const) {
      const values = descriptors.map((d) => d[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  // A `g` or `y` pattern keeps `lastIndex` between `test()` calls, so the same id passes, then fails.
  test('every pattern has no flags', () => {
    const patterns = regexps(CHANNELS);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(pattern.flags).toBe('');
  });

  // A button names its option by a two-digit index (core/questions.ts).
  test('at most 100 buttons', () => {
    for (const d of descriptors) if ('buttons' in d) expect(d.buttons.max).toBeLessThanOrEqual(100);
  });

  test('only a descriptor id is a channel platform', () => {
    for (const id of CHANNEL_PLATFORM_IDS) expect(isChannelPlatform(id)).toBe(true);
    for (const other of ['discord', 'Slack', '', 'constructor', '__proto__', 'toString']) expect(isChannelPlatform(other)).toBe(false);
  });
});
