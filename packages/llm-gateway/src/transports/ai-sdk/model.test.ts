import { describe, expect, test } from 'bun:test';
import { trimTrailingSlash } from './model';

// trimTrailingSlash was rewritten from `url.replace(/\/+$/, '')` to a
// linear-time charCodeAt loop to clear CodeQL `js/polynomial-redos` (high,
// alert #4731). These tests pin the behavior the regex had — including the
// adversarial many-slash input that was the whole point of the rewrite.
describe('trimTrailingSlash', () => {
  test.each([
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['https://api.example.com////', 'https://api.example.com'],
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/v1/chat', 'https://api.example.com/v1/chat'],
    ['', ''],
    ['/'.repeat(1_000), ''],
  ])('%p -> %p', (input, output) => {
    expect(trimTrailingSlash(input)).toBe(output);
  });

  test('a long slash run that does not end the string is linear (the ReDoS input)', () => {
    // The old `/\/+$/` backtracked from every slash of this run: quadratic.
    const adversarial = `${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlash(adversarial)).toBe(adversarial);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
