import { describe, expect, test } from 'bun:test';
import { promptFromSearchParams } from './prompt-from-search-params';

describe('promptFromSearchParams', () => {
  test('returns the trimmed q value when present', () => {
    const params = new URLSearchParams('q=Read+this+doc');
    expect(promptFromSearchParams(params)).toBe('Read this doc');
  });

  test('returns null when q is absent', () => {
    const params = new URLSearchParams('other=1');
    expect(promptFromSearchParams(params)).toBeNull();
  });

  test('returns null when q is empty', () => {
    const params = new URLSearchParams('q=');
    expect(promptFromSearchParams(params)).toBeNull();
  });

  test('returns null when q is whitespace only', () => {
    const params = new URLSearchParams('q=%20%20');
    expect(promptFromSearchParams(params)).toBeNull();
  });

  test('trims surrounding whitespace from a real value', () => {
    const params = new URLSearchParams('q=%20hello%20world%20');
    expect(promptFromSearchParams(params)).toBe('hello world');
  });

  test('decodes URL-encoded characters', () => {
    const params = new URLSearchParams();
    params.set('q', 'Read https://kortix.com/docs/sdk so I can ask questions about it.');
    expect(promptFromSearchParams(params)).toBe(
      'Read https://kortix.com/docs/sdk so I can ask questions about it.',
    );
  });
});
