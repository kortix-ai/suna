import { describe, expect, test } from 'bun:test';

import { decodeHtmlEntitiesOnce, extractReadableHtml, stripMarkupForToolOutput } from './html-text';

// Phase-1 characterization cases (KRTX-366): the shared module implements the
// web copy's semantics, pinned before any host imports it. KRTX-365 phase 3
// moved the host copies onto this module.
const cases: [string, string, { title?: string; text: string }][] = [
  ['entities', '<title>A &amp; B</title><p>&nbsp;&#65;&#x42; &unknown; &abcdefghijklmnop;</p>', { title: 'A & B', text: 'A & B\nAB &unknown; &abcdefghijklmnop;' }],
  ['nested blocks and breaks', '<article><h1> One </h1><div>Two <b>three</b><br>four</div></article>', { title: undefined, text: 'One\nTwo three\nfour' }],
  ['head and active content', '<head><title>  The <b>title</b> &quot;X&quot; </title><style>hidden</style></head><script>hidden</script><p>shown</p>', { title: 'The title "X"', text: 'shown' }],
  ['broken markup and comments', '<p>one<!-- hidden -->two</p><div>three<unclosed', { title: undefined, text: 'onetwo\nthree' }],
  ['whitespace', '<p>  alpha\t beta  </p>\n\n<p> gamma\r\ndelta </p>', { title: undefined, text: 'alpha beta\ngamma\ndelta' }],
];

describe('extractReadableHtml', () => {
  test.each(cases)('%s', (_name, html, expected) => {
    expect(extractReadableHtml(html)).toEqual(expected);
  });
  test('reads the title and the visible text, skipping head, script and style', () => {
    const html =
      '<!doctype html><html><head><title>Kortix &amp; Co</title><style>p{}</style></head>' +
      '<body><script>var x = "<p>no</p>";</script><h1>Hello</h1><p>World &lt;3</p><!-- hidden --></body></html>';
    const { title, text } = extractReadableHtml(html);
    expect(title).toBe('Kortix & Co');
    expect(text).toBe('Hello\nWorld <3');
  });

  test('a page without a title has no title', () => {
    expect(extractReadableHtml('<div>a</div>').title).toBeUndefined();
  });
});

test('markup stripping and one-pass entity decoding', () => {
  expect(stripMarkupForToolOutput(' A <b>B</b> <!--x--> C ')).toBe('A B C');
  expect(decodeHtmlEntitiesOnce('&amp;lt; &#x1F642; &unknown; &abcdefghijklmnop;')).toBe('&lt; 🙂 &unknown; &abcdefghijklmnop;');
});
