import { describe, expect, test } from 'bun:test';

import { firstNameOf } from './first-chat-name';

describe('firstNameOf', () => {
  test('greets by first name from full_name', () => {
    expect(firstNameOf({ full_name: 'Jay Suthar' })).toBe('Jay');
  });

  test('falls back to name when full_name is missing', () => {
    expect(firstNameOf({ name: 'Marko' })).toBe('Marko');
  });

  test('ignores surrounding and repeated whitespace', () => {
    expect(firstNameOf({ full_name: '  Ada   Lovelace ' })).toBe('Ada');
  });

  // An empty name must fall through to the no-name greeting, never render
  // "Welcome, ." with a hole where the name was.
  test('returns an empty string when there is no usable name', () => {
    expect(firstNameOf(undefined)).toBe('');
    expect(firstNameOf({})).toBe('');
    expect(firstNameOf({ full_name: '   ' })).toBe('');
    expect(firstNameOf({ full_name: 42 })).toBe('');
  });
});
