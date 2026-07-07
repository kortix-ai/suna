import { describe, test, expect } from 'bun:test';
import { autoLinkUrls } from './url-autolink';

describe('autoLinkUrls', () => {
  test('returns empty string unchanged', () => {
    expect(autoLinkUrls('')).toBe('');
  });

  test('returns text with no links unchanged', () => {
    expect(autoLinkUrls('just some plain text here')).toBe('just some plain text here');
  });

  test('linkifies a full https url', () => {
    expect(autoLinkUrls('see https://github.com/kubet/mk-blog now')).toBe(
      'see [https://github.com/kubet/mk-blog](https://github.com/kubet/mk-blog) now',
    );
  });

  test('linkifies a bare domain by adding https protocol', () => {
    expect(autoLinkUrls('visit example.com today')).toBe(
      'visit [example.com](https://example.com) today',
    );
  });

  test('linkifies a www-prefixed url and keeps www in the href', () => {
    expect(autoLinkUrls('go to www.example.com')).toBe(
      'go to [www.example.com](https://www.example.com)',
    );
  });

  test('converts an email into a mailto link', () => {
    expect(autoLinkUrls('mail me at user@example.com please')).toBe(
      'mail me at [user@example.com](mailto:user@example.com) please',
    );
  });

  test('does not double-wrap an existing markdown link', () => {
    const input = 'click [here](https://example.com)';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside inline code', () => {
    const input = 'run `curl example.com`';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside a fenced code block', () => {
    const input = '```\nfetch example.com\n```';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('linkifies domains between escaped currency amounts (post-preprocess)', () => {
    const input =
      'raised \\$4M). Earlier from example.com. Built SoftGen (\\$50K MRR).';
    expect(autoLinkUrls(input)).toBe(
      'raised \\$4M). Earlier from [example.com](https://example.com). Built SoftGen (\\$50K MRR).',
    );
  });

  test('does not linkify urls inside inline math', () => {
    const input = 'value $a.com$ end';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('still protects urls inside block math', () => {
    const input = 'equation $$x = \\text{see example.com}$$ end';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside angle brackets', () => {
    const input = 'see <https://example.com>';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('linkifies multiple urls in the same text', () => {
    const result = autoLinkUrls('a.com and b.org');
    expect(result).toBe('[a.com](https://a.com) and [b.org](https://b.org)');
  });

  test('preserves a path on a bare domain', () => {
    expect(autoLinkUrls('open example.com/path/to/page')).toBe(
      'open [example.com/path/to/page](https://example.com/path/to/page)',
    );
  });

  test('does not treat a plain sentence word as a domain', () => {
    expect(autoLinkUrls('hello world end')).toBe('hello world end');
  });

  test('returns non-string input unchanged', () => {
    expect(autoLinkUrls(null as any)).toBeNull();
    expect(autoLinkUrls(undefined as any)).toBeUndefined();
  });

  test('skips a bare domain immediately after a slash (file path, old lookbehind semantics)', () => {
    expect(autoLinkUrls('see /etc/config.com for details')).toBe('see /etc/config.com for details');
  });

  test('still links a protocol url even when preceded by a slash', () => {
    expect(autoLinkUrls('mirror /https://example.com')).toBe(
      'mirror /[https://example.com](https://example.com)',
    );
  });

  test('protects adjacent inline math spans without consuming separators', () => {
    expect(autoLinkUrls('$a.com$$b.org$')).toBe('$a.com$$b.org$');
  });

  test('escaped dollars do not open math spans, so following urls still link', () => {
    expect(autoLinkUrls('costs \\$5 at example.com today')).toBe(
      'costs \\$5 at [example.com](https://example.com) today',
    );
  });

  test('inline math spanning a url keeps it unlinked', () => {
    expect(autoLinkUrls('math $x = example.com$ end')).toBe('math $x = example.com$ end');
  });
});
