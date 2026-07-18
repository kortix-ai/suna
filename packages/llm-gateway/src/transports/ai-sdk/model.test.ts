import { describe, expect, test } from 'bun:test';
import { trimTrailingSlash } from './model';

// trimTrailingSlash was rewritten from `url.replace(/\/+$/, '')` to a
// linear-time charCodeAt loop to clear CodeQL `js/polynomial-redos` (high,
// alert #4731). These tests pin the behavior the regex had — including the
// adversarial many-slash input that was the whole point of the rewrite.
describe('trimTrailingSlash', () => {
  test('strips a single trailing slash', () => {
    expect(trimTrailingSlash('https://api.example.com/')).toBe('https://api.example.com');
  });

  test('strips many trailing slashes', () => {
    expect(trimTrailingSlash('https://api.example.com////')).toBe('https://api.example.com');
  });

  test('leaves a URL with no trailing slash unchanged', () => {
    expect(trimTrailingSlash('https://api.example.com')).toBe('https://api.example.com');
  });

  test('does NOT strip internal slashes', () => {
    expect(trimTrailingSlash('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });

  test('empty string is a no-op', () => {
    expect(trimTrailingSlash('')).toBe('');
  });

  test('all-slashes input collapses to empty (the ReDoS adversarial case)', () => {
    // 100k slashes — would be quadratic under the old regex, linear now.
    const adversarial = '/'.repeat(100_000);
    expect(trimTrailingSlash(adversarial)).toBe('');
  });

  test('preserves a path that ends in a non-slash char', () => {
    expect(trimTrailingSlash('https://api.example.com/v1/chat')).toBe(
      'https://api.example.com/v1/chat',
    );
  });
});
