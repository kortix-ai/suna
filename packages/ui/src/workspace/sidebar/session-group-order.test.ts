import { describe, expect, test } from 'bun:test';

import { moveGroupBy, moveGroupTo } from './session-group-order';

const IDS = ['a', 'b', 'c', 'd'];

describe('moveGroupTo — a dragged group takes the place of the group it is dropped on', () => {
  test('dropped on a group below it, it lands after that group', () => {
    expect(moveGroupTo(IDS, 'a', IDS.indexOf('c'))).toEqual(['b', 'c', 'a', 'd']);
  });

  test('dropped on a group above it, it lands before that group', () => {
    expect(moveGroupTo(IDS, 'd', IDS.indexOf('b'))).toEqual(['a', 'd', 'b', 'c']);
  });

  test('dropped on itself, or an unknown id, nothing moves', () => {
    expect(moveGroupTo(IDS, 'b', 1)).toBeNull();
    expect(moveGroupTo(IDS, 'x', 0)).toBeNull();
  });

  test('an index past either end clamps to that end', () => {
    expect(moveGroupTo(IDS, 'b', 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveGroupTo(IDS, 'c', -3)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('moveGroupBy — Move up and Move down', () => {
  test('moves one place', () => {
    expect(moveGroupBy(IDS, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveGroupBy(IDS, 'c', 1)).toEqual(['a', 'b', 'd', 'c']);
  });

  test('null at either end, so the menu disables the item', () => {
    expect(moveGroupBy(IDS, 'a', -1)).toBeNull();
    expect(moveGroupBy(IDS, 'd', 1)).toBeNull();
  });
});
