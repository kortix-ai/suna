import { describe, expect, test } from 'bun:test';

import { resolveLabelFacetOptions } from './session-label-facet';

describe('resolveLabelFacetOptions', () => {
  test('counts labels across sessions, most used first, then by name', () => {
    const sessions = [{ labels: ['bug', 'ui'] }, { labels: ['bug'] }, { labels: ['api'] }, {}];
    expect(resolveLabelFacetOptions(sessions, [])).toEqual([
      { value: 'bug', count: 2 },
      { value: 'api', count: 1 },
      { value: 'ui', count: 1 },
    ]);
  });

  test('keeps a selected label no loaded session carries, so it can be unchecked', () => {
    expect(resolveLabelFacetOptions([{ labels: ['bug'] }], ['gone'])).toEqual([
      { value: 'bug', count: 1 },
      { value: 'gone', count: 0 },
    ]);
  });
});
