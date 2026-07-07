import { describe, expect, test } from 'bun:test';
import { escapeCurrencyDollars } from './katex-markdown';

describe('escapeCurrencyDollars', () => {
  test('escapes a currency dollar before a digit', () => {
    expect(escapeCurrencyDollars('raised $4M this year')).toBe('raised \\$4M this year');
  });

  test('escapes mid-word currency after a letter', () => {
    expect(escapeCurrencyDollars('price:$1.99')).toBe('price:\\$1.99');
  });

  test('leaves already-escaped dollars unchanged', () => {
    expect(escapeCurrencyDollars('costs \\$5 today')).toBe('costs \\$5 today');
  });

  test('leaves double-dollar block math delimiters unchanged', () => {
    expect(escapeCurrencyDollars('$$5x$$')).toBe('$$5x$$');
  });

  test('leaves inline math without leading digit unchanged', () => {
    expect(escapeCurrencyDollars('formula $E = mc^2$ holds')).toBe('formula $E = mc^2$ holds');
  });

  test('escapes each independent currency amount', () => {
    expect(escapeCurrencyDollars('$5 and $10')).toBe('\\$5 and \\$10');
  });

  test('returns non-string input unchanged', () => {
    expect(escapeCurrencyDollars('')).toBe('');
    expect(escapeCurrencyDollars(null as unknown as string)).toBeNull();
  });
});
