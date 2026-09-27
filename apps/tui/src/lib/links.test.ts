import { describe, expect, test } from 'bun:test';

import { extractUrls, extractUrlsFromScreen, joinWrappedRows } from './links.ts';

describe('extractUrls', () => {
  test('finds http and https URLs in prose, in order, deduplicated', () => {
    expect(
      extractUrls(
        'see https://kortix.com/docs and http://localhost:3000 then https://kortix.com/docs',
      ),
    ).toEqual(['https://kortix.com/docs', 'http://localhost:3000']);
  });

  test('drops sentence punctuation and unmatched brackets', () => {
    expect(
      extractUrls('Open (https://x.dev/a). Or https://x.dev/b, or [https://x.dev/c]!'),
    ).toEqual(['https://x.dev/a', 'https://x.dev/b', 'https://x.dev/c']);
  });

  test('keeps a matched closing bracket and query strings', () => {
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar) x')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(
      extractUrls('https://auth.example.com/oauth/authorize?response_type=code&scope=a+b#frag'),
    ).toEqual(['https://auth.example.com/oauth/authorize?response_type=code&scope=a+b#frag']);
  });

  test('ignores a bare scheme and empty text', () => {
    expect(extractUrls('https:// and http://')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });
});

describe('joinWrappedRows', () => {
  test('a row filled to the last column continues on the next row', () => {
    const columns = 20;
    const rows = ['  https://a.dev/abcd', 'efgh?x=1', 'next line', '', 'plain'];
    expect(joinWrappedRows(rows, columns)).toBe('  https://a.dev/abcdefgh?x=1\nnext line\n\nplain');
  });

  test('right-padded rows are trimmed before the fill test', () => {
    expect(joinWrappedRows(['short     ', 'abcdefghij', 'klm'], 10)).toBe('short\nabcdefghijklm');
  });

  test('a trailing wrapped row is not lost', () => {
    expect(joinWrappedRows(['abcde', 'fghij'], 5)).toBe('abcdefghij');
  });
});

describe('extractUrlsFromScreen', () => {
  test('rebuilds a URL the emulator wrapped across three rows', () => {
    const columns = 48;
    const url =
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc';
    const rows: string[] = [];
    rows.push('  If the link does not open automatically:');
    rows.push('');
    for (let i = 0; i < url.length; i += columns) rows.push(url.slice(i, i + columns));
    rows.push('');
    rows.push('  Press esc to cancel');
    expect(extractUrlsFromScreen(rows, columns)).toEqual([url]);
  });
});
