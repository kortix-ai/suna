import { describe, expect, it } from 'bun:test';
import { truncate } from './string';

describe('truncate', () => {
  it('passes through short strings', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('truncates long strings with ellipsis', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});
