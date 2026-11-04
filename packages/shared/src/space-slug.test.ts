import { describe, expect, test } from 'bun:test';
import { spaceSlug } from './space-slug';

describe('spaceSlug', () => {
  test('lowercases and joins words with one dash', () => {
    expect(spaceSlug('  Design   Reviews ')).toBe('design-reviews');
  });

  test('drops characters outside a-z, 0-9 and dash', () => {
    expect(spaceSlug('Q4 launch! (EU)')).toBe('q4-launch-eu');
  });

  test('collapses dash runs and trims dashes at both ends', () => {
    expect(spaceSlug('--a -- b--')).toBe('a-b');
  });

  test('is empty for a name with no letter or digit', () => {
    expect(spaceSlug('!!! ???')).toBe('');
  });

  test('cuts at 40 characters and trims a trailing dash left by the cut', () => {
    const slug = spaceSlug(`${'a'.repeat(39)} b`);
    expect(slug).toBe('a'.repeat(39));
    expect(spaceSlug('x'.repeat(60))).toHaveLength(40);
  });
});
