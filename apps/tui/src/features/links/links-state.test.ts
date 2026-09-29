import { describe, expect, test } from 'bun:test';

import { MAX_LINK_ROWS, sameLinks, withLinks } from './links-state.ts';

describe('withLinks', () => {
  test('new URLs go to the front, in the order given, deduplicated', () => {
    const rows = withLinks([], ['https://a.dev', 'https://b.dev', 'https://a.dev'], 'transcript');
    expect(rows).toEqual([
      { url: 'https://a.dev', source: 'transcript' },
      { url: 'https://b.dev', source: 'transcript' },
    ]);
  });

  test('a URL seen again moves to the front and takes the new source', () => {
    const first = withLinks([], ['https://a.dev', 'https://b.dev'], 'transcript');
    const next = withLinks(first, ['https://b.dev'], 'terminal');
    expect(next).toEqual([
      { url: 'https://b.dev', source: 'terminal' },
      { url: 'https://a.dev', source: 'transcript' },
    ]);
  });

  test('the list is capped', () => {
    const many = Array.from({ length: MAX_LINK_ROWS + 10 }, (_, i) => `https://x.dev/${i}`);
    expect(withLinks([], many, 'terminal')).toHaveLength(MAX_LINK_ROWS);
  });

  test('no URLs is a copy, not the same array', () => {
    const rows = withLinks([], ['https://a.dev'], 'terminal');
    const same = withLinks(rows, [], 'terminal');
    expect(same).toEqual(rows);
    expect(same).not.toBe(rows);
  });
});

describe('sameLinks', () => {
  test('compares url and source, in order', () => {
    const a = [{ url: 'https://a.dev', source: 'terminal' as const }];
    expect(sameLinks(a, [{ url: 'https://a.dev', source: 'terminal' }])).toBe(true);
    expect(sameLinks(a, [{ url: 'https://a.dev', source: 'transcript' }])).toBe(false);
    expect(sameLinks(a, [])).toBe(false);
  });
});
