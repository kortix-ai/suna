import { describe, expect, test } from 'bun:test';
import { hasMarkdownLink, hasOrderedListItem, looksLikeMarkdown } from './markdown-detect';
import { chooser, within } from './testing';

// The markdown detector the web and mobile tool renderers ran, verbatim, kept
// ONLY as the parity oracle.
const MD_SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m,
  /```/,
  /\*\*[^*\n]+\*\*/,
  /(^|[^`])`[^`\n]+`([^`]|$)/,
  /\[[^\]\n]+\]\([^)\n]+\)/,
  /^\s*\d+\.\s+\S/m,
];
const legacy = (text: string) => MD_SIGNALS.some((re) => re.test(text));

const LS = String.fromCharCode(0x2028);

/** Runs `check` on 3000 texts from `make` and proves at least 600 of them matched. */
function fuzz(
  seed: number,
  make: (c: ReturnType<typeof chooser>) => string,
  check: (text: string) => boolean,
) {
  const c = chooser(seed);
  let matched = 0;
  for (let i = 0; i < 3000; i++) if (check(make(c))) matched++;
  expect(matched).toBeGreaterThan(600);
}

describe('the markdown readers return what their regexes returned', () => {
  test('hasMarkdownLink', () =>
    fuzz(
      121,
      (c) => c.some(['[', ']', '(', ')', 'a', ' ', '\n', LS, '[a](b)', '[]', '()', '](', '\r'], 8),
      (text) => {
        const expected = /\[[^\]\n]+\]\([^)\n]+\)/.test(text);
        expect(hasMarkdownLink(text)).toBe(expected);
        return expected;
      },
    ));

  test('hasOrderedListItem', () =>
    fuzz(
      122,
      (c) =>
        c.some(
          ['1.', '12.', '.', '1', ' ', '  ', '\n', '\r\n', LS, '\t', 'a', '1. x', ' 2.\n y'],
          8,
        ),
      (text) => {
        const expected = /^\s*\d+\.\s+\S/m.test(text);
        expect(hasOrderedListItem(text)).toBe(expected);
        return expected;
      },
    ));
});

describe('looksLikeMarkdown', () => {
  test('returns what the regex detector returned on 3000 random outputs', () =>
    fuzz(
      123,
      (c) =>
        c.some(
          [
            '# ',
            '##',
            '```',
            '**b**',
            '`x`',
            '[a](b)',
            '1. ',
            '- item',
            ' ',
            '\n',
            'text',
            '*',
            '[',
            '(',
            ')',
            ']',
          ],
          6,
        ),
      (text) => {
        const expected = legacy(text);
        expect(looksLikeMarkdown(text)).toBe(expected);
        return expected;
      },
    ));
});

describe('no tool output can freeze the markdown detector', () => {
  within('60k "[a](" link starts that never close (240k characters)', () =>
    looksLikeMarkdown('[a]('.repeat(60_000)),
  );
  within('240k blank lines before a line that is not a list item', () =>
    looksLikeMarkdown(`${'\n'.repeat(240_000)}1x`),
  );
  within('120k blank lines of one space, then "1." with no text', () =>
    looksLikeMarkdown(`${' \n'.repeat(120_000)}1.`),
  );
});
