import { expect, test } from 'bun:test';
import { pinRank, sortByPicks, UNPINNED_RANK } from './connector-sections';

test('catalogue picks preserve ordering, alternate spellings, and input arrays', () => {
  const items = [
    { slug: 'unlisted-first', name: 'Unlisted first' },
    { slug: 'google_sheets', name: 'Sheets' },
    { slug: 'opaque', name: 'Notion' },
    { slug: 'unlisted-last', name: 'Unlisted last' },
  ];
  expect(sortByPicks('productivity', items).map((item) => item.slug)).toEqual([
    'opaque', 'google_sheets', 'unlisted-first', 'unlisted-last',
  ]);
  expect(items.map((item) => item.slug)).toEqual([
    'unlisted-first', 'google_sheets', 'opaque', 'unlisted-last',
  ]);
  expect(pinRank('productivity', { slug: 'google_sheets', name: 'Sheets' })).toBe(2);
  expect(pinRank('missing', items[0])).toBe(UNPINNED_RANK);
  const unchanged = sortByPicks('missing', items);
  expect(unchanged).toEqual(items);
  expect(unchanged).not.toBe(items);
  expect(sortByPicks('productivity', [])).toEqual([]);
});
