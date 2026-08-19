import { describe, test, expect } from 'bun:test';
import { capitalizeWords, truncateString } from './string';

describe('truncateString', () => {
  test('returns empty string for undefined input', () => {
    expect(truncateString(undefined)).toBe('');
  });

  test('returns empty string for empty input', () => {
    expect(truncateString('')).toBe('');
  });

  test('returns the string unchanged when shorter than max length', () => {
    expect(truncateString('hello', 50)).toBe('hello');
  });

  test('returns the string unchanged when exactly at max length', () => {
    const str = 'a'.repeat(10);
    expect(truncateString(str, 10)).toBe(str);
  });

  test('truncates and appends ellipsis when longer than max length', () => {
    const str = 'a'.repeat(11);
    expect(truncateString(str, 10)).toBe('a'.repeat(10) + '...');
  });

  test('uses default max length of 50', () => {
    const str = 'b'.repeat(60);
    const result = truncateString(str);
    expect(result).toBe('b'.repeat(50) + '...');
  });

  test('does not truncate a 50 character string with default max length', () => {
    const str = 'c'.repeat(50);
    expect(truncateString(str)).toBe(str);
  });

  test('truncates a 51 character string with default max length', () => {
    const str = 'd'.repeat(51);
    expect(truncateString(str)).toBe('d'.repeat(50) + '...');
  });

  test('handles a max length of zero by truncating everything', () => {
    expect(truncateString('hello', 0)).toBe('...');
  });

  test('preserves the leading slice content when truncating', () => {
    expect(truncateString('abcdefghij', 3)).toBe('abc...');
  });
});

describe('capitalizeWords', () => {
  test('returns empty string unchanged', () => {
    expect(capitalizeWords('')).toBe('');
  });

  test('capitalizes a single lowercase word', () => {
    expect(capitalizeWords('kortix')).toBe('Kortix');
  });

  test('capitalizes each hyphen-separated segment', () => {
    expect(capitalizeWords('harness-reflector')).toBe('Harness-Reflector');
    expect(capitalizeWords('session-reviewer')).toBe('Session-Reviewer');
  });

  test('capitalizes each space-separated word', () => {
    expect(capitalizeWords('customer support agent')).toBe('Customer Support Agent');
  });

  test('leaves an already-capitalized name unchanged', () => {
    expect(capitalizeWords('Kortix')).toBe('Kortix');
  });

  test('leaves digits and internal casing alone, only touches word starts', () => {
    expect(capitalizeWords('gpt5-agent')).toBe('Gpt5-Agent');
  });
});
