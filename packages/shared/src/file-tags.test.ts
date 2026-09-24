import { describe, expect, test } from 'bun:test';
import { fileTagBlocks } from './file-tags';

/** The regex every reader used before — kept here ONLY as the parity oracle. */
const LEGACY = /<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g;
const legacy = (text: string) =>
  [...text.matchAll(LEGACY)].map((m) => ({
    index: m.index!,
    end: m.index! + m[0].length,
    attrs: m[1]!,
  }));

describe('fileTagBlocks finds exactly what the old regex found', () => {
  const cases: Record<string, string> = {
    'one tag': 'Read this. <file path="/workspace/a.txt" mime="text/plain" filename="a.txt">Uploaded</file>',
    'two tags and prose between': 'x <file path="/w/a.png">A</file> y <file path="/w/b.pdf" filename="b.pdf">B</file> z',
    'escaped attribute values': '<file path="/workspace/uploads/R&amp;D.txt" filename="R&amp;D.txt">x</file>',
    'multi-line body': '<file path="/w/a.md">line 1\nline 2\n</file>',
    'body that mentions a tag': '<file path="/w/outer.txt">see <file path="/w/inner"> in text</file> after',
    'leading and trailing whitespace in attrs': '<file   path="/w/a"  >x</file>',
    'tab and newline after the name': '<file\tpath="/w/a">x</file><file\npath="/w/b">y</file>',
    'no whitespace after the name is not a tag': '<filepath="/w/a">x</file>',
    'no attrs at all is not a tag': '<file>x</file>',
    'an opener with no closer': 'before <file path="/w/a"> and nothing closes it',
    'a closer with no opener': 'just </file> here',
    'a later closed tag after an unclosed one': '<file path="/w/a"> x <file path="/w/b">y</file>',
    'an empty string': '',
  };
  for (const [name, text] of Object.entries(cases)) {
    test(name, () => {
      expect(fileTagBlocks(text)).toEqual(legacy(text));
    });
  }
});

describe('fileTagBlocks is linear on the inputs that made the regex quadratic', () => {
  // The regex took 125 ms at 20k characters and quadrupled per doubling; at
  // 200k it would take ~12 s. A generous bound still proves the shape changed.
  const within = (label: string, text: string) =>
    test(label, () => {
      const started = performance.now();
      fileTagBlocks(text);
      expect(performance.now() - started).toBeLessThan(100);
    });
  within('<file then 200k whitespace and no >', `<file${'\t'.repeat(200_000)}`);
  within('200k of "<file\\t" with no > anywhere', '<file\t'.repeat(40_000));
  within('openers that never close', '<file x>'.repeat(25_000));
  within('many closed tags', '<file path="/w/a">x</file>'.repeat(8_000));
});

test('a non-string yields nothing rather than throwing', () => {
  expect(fileTagBlocks(undefined as never)).toEqual([]);
});
