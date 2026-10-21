import { describe, expect, test } from 'bun:test';

import { spacesThreadHref } from './web-notifications';

describe('spacesThreadHref: a finished turn on a channel or DM page opens in its thread panel', () => {
  test('a channel page opens the thread in its panel', () => {
    expect(spacesThreadHref('/projects/p1/c/general', '', 's1')).toBe('/projects/p1/c/general?thread=s1');
  });

  test('a DM page keeps its other params and replaces the open thread', () => {
    expect(spacesThreadHref('/projects/p1/dm/kortix', '?tab=files&thread=old', 's2')).toBe(
      '/projects/p1/dm/kortix?tab=files&thread=s2',
    );
  });

  test('a locale prefix is kept', () => {
    expect(spacesThreadHref('/de/projects/p1/c/general', '', 's1')).toBe('/de/projects/p1/c/general?thread=s1');
  });

  test('any other page has no thread panel', () => {
    expect(spacesThreadHref('/projects/p1/sessions/s1', '', 's1')).toBeNull();
    expect(spacesThreadHref('/projects/p1', '', 's1')).toBeNull();
    expect(spacesThreadHref('/projects/p1/c/general/settings', '', 's1')).toBeNull();
  });
});
