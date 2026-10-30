import { describe, expect, test } from 'bun:test';
import { catalogEmptyKind } from './catalog-empty';

describe('catalogEmptyKind', () => {
  test('nothing at all -> empty', () => {
    expect(catalogEmptyKind(0, 0)).toBe('empty');
  });
  test('items exist but the filter hid all of them -> no-match', () => {
    expect(catalogEmptyKind(10, 0)).toBe('no-match');
  });
  test('anything visible -> null (render the grid, not an empty state)', () => {
    expect(catalogEmptyKind(10, 3)).toBeNull();
    expect(catalogEmptyKind(1, 1)).toBeNull();
  });
});
