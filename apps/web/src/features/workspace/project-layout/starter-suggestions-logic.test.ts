import { describe, expect, test } from 'bun:test';

import { suggestionRowKind, visibleSuggestions } from './starter-suggestions-logic';

describe('visibleSuggestions', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'];

  test('returns the first `max` items', () => {
    expect(visibleSuggestions(pool, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a pool smaller than max renders what exists', () => {
    expect(visibleSuggestions(['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  test('an empty pool renders nothing', () => {
    expect(visibleSuggestions([], 5)).toEqual([]);
  });

  test('does not mutate the source pool', () => {
    const source = ['a', 'b', 'c'];
    visibleSuggestions(source, 2);
    expect(source).toEqual(['a', 'b', 'c']);
  });
});

describe('suggestionRowKind', () => {
  const connector = { slug: 'slack', name: 'Slack', img_src: 'https://example.test/slack.png' };

  test('an item with no action is a prompt row', () => {
    expect(suggestionRowKind({}, true)).toBe('prompt');
    expect(suggestionRowKind({ action: undefined }, true)).toBe('prompt');
  });

  test('a connectors action with a connector record and write access is a connector row', () => {
    expect(suggestionRowKind({ action: 'connectors', connector }, true)).toBe('connector');
  });

  test('a connectors action without write access falls back to an action row', () => {
    expect(suggestionRowKind({ action: 'connectors', connector }, false)).toBe('action');
  });

  test('a connectors action with no connector record falls back to an action row', () => {
    expect(suggestionRowKind({ action: 'connectors' }, true)).toBe('action');
    expect(suggestionRowKind({ action: 'connectors', connector: null }, true)).toBe('action');
  });

  test('a non-connectors action is always an action row, connector field or not', () => {
    expect(suggestionRowKind({ action: 'schedules' }, true)).toBe('action');
    expect(suggestionRowKind({ action: 'schedules', connector }, true)).toBe('action');
  });

  test('a skills action is always a skill row, canConnect or not', () => {
    expect(suggestionRowKind({ action: 'skills' }, true)).toBe('skill');
    expect(suggestionRowKind({ action: 'skills' }, false)).toBe('skill');
  });

  test('a skills action with a connector field is still a skill row, not a connector row', () => {
    expect(suggestionRowKind({ action: 'skills', connector }, true)).toBe('skill');
  });
});
