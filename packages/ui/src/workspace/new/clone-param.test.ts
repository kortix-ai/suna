import { describe, expect, test } from 'bun:test';

import { readCloneParam } from './clone-param';

describe('readCloneParam', () => {
  test('returns the item id', () => {
    expect(readCloneParam(new URLSearchParams('clone=item-1'))).toBe('item-1');
  });

  test('returns null when absent', () => {
    expect(readCloneParam(new URLSearchParams(''))).toBeNull();
  });

  test('returns null for an empty or whitespace value', () => {
    expect(readCloneParam(new URLSearchParams('clone='))).toBeNull();
    expect(readCloneParam(new URLSearchParams('clone=%20%20'))).toBeNull();
  });

  test('trims surrounding whitespace', () => {
    expect(readCloneParam(new URLSearchParams('clone=%20item-1%20'))).toBe('item-1');
  });
});
