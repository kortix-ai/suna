import { expect, test } from 'bun:test';

import { decodeHtmlEntitiesOnce, extractReadableHtml, stripMarkupForToolOutput } from './tool-renderers-sanitization';

const cases: [string, string, { title?: string; text: string }][] = [
  ['entities', '<title>A &amp; B</title><p>&nbsp;&#65;&#x42; &unknown; &abcdefghijklmnop;</p>', { title: 'A & B', text: 'A & B\nAB &unknown; &abcdefghijklmnop;' }],
  ['nested blocks and breaks', '<article><h1> One </h1><div>Two <b>three</b><br>four</div></article>', { title: undefined, text: 'One\nTwo three\nfour' }],
  ['head and active content', '<head><title>  The <b>title</b> &quot;X&quot; </title><style>hidden</style></head><script>hidden</script><p>shown</p>', { title: 'The title "X"', text: 'shown' }],
  ['broken markup and comments', '<p>one<!-- hidden -->two</p><div>three<unclosed', { title: undefined, text: 'onetwo\nthree' }],
  ['whitespace', '<p>  alpha\t beta  </p>\n\n<p> gamma\r\ndelta </p>', { title: undefined, text: 'alpha beta\ngamma\ndelta' }],
];

test.each(cases)('web sanitizer: %s', (_name, html, expected) => {
  expect(extractReadableHtml(html)).toEqual(expected);
});

test('web markup stripping and one-pass entity decoding', () => {
  expect(stripMarkupForToolOutput(' A <b>B</b> <!--x--> C ')).toBe('A B C');
  expect(decodeHtmlEntitiesOnce('&amp;lt; &#x1F642; &unknown; &abcdefghijklmnop;')).toBe('&lt; 🙂 &unknown; &abcdefghijklmnop;');
});
