import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isMarkdownSeparatorBlock, splitMarkdownBlocks } from './split-blocks';

// The exact markdown-it build react-native-markdown-display parses with, configured the
// way the chat renderer configures it. Rendering the whole text and rendering every block
// separately must produce the same HTML, or the split changed what the user sees.
const appRequire = createRequire(import.meta.url);
const rendererRequire = createRequire(
  realpathSync(appRequire.resolve('react-native-markdown-display/package.json')),
);
const MarkdownIt = rendererRequire('markdown-it') as (options: { typographer: boolean }) => {
  render: (source: string) => string;
};
const md = MarkdownIt({ typographer: true });

// The renderer's fence and code_block rules drop one trailing newline from the
// code, so a code block cut off at a block end renders the same as one ending in
// a newline.
function render(source: string): string {
  return md.render(source).replace(/\n<\/code><\/pre>/g, '</code></pre>');
}

function renderSplit(text: string): { blocks: string[]; split: string; whole: string } {
  const blocks = splitMarkdownBlocks(text);
  return { blocks, split: blocks.map(render).join(''), whole: render(text) };
}

function expectSameRendering(text: string) {
  const { blocks, split, whole } = renderSplit(text);
  expect(split).toBe(whole);
  return blocks;
}

describe('splitMarkdownBlocks', () => {
  test('returns no blocks for empty or blank text', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n  \n')).toEqual([]);
  });

  test('splits paragraphs and headings on blank lines', () => {
    const blocks = expectSameRendering('# Title\n\nFirst paragraph\nstill first\n\n\nSecond');
    expect(blocks).toEqual(['# Title', 'First paragraph\nstill first', 'Second']);
  });

  test('keeps a fenced code block with blank lines in one block', () => {
    const text = 'Intro\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '```ts\nconst a = 1;\n\n\nconst b = 2;\n```', 'After']);
  });

  test('keeps a tilde fence with an info string in one block', () => {
    const text = '~~~python title="x"\nprint(1)\n\nprint(2)\n~~~\n\nDone';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['~~~python title="x"\nprint(1)\n\nprint(2)\n~~~', 'Done']);
  });

  test('a shorter or differently fenced inner line does not close the fence', () => {
    const text = '````md\n```\n\ninner\n~~~\n\n````\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['````md\n```\n\ninner\n~~~\n\n````', 'After']);
  });

  test('a fence marker indented four columns past the opener does not close it', () => {
    const text = '```\ncode\n    ```\n\nstill code\n```\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['```\ncode\n    ```\n\nstill code\n```', 'After']);
  });

  test('backticks in the info string mean the line is not a fence opener', () => {
    const text = '``` not `a` fence\n\nNext';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['``` not `a` fence', 'Next']);
  });

  test('an unterminated fence while streaming keeps everything after it in one block', () => {
    const text = 'Intro\n\n```js\nfunction a() {}\n\n\nfunction b() {}\n\nlet c';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '```js\nfunction a() {}\n\n\nfunction b() {}\n\nlet c']);
  });

  test('a fence inside a list item keeps its blank lines', () => {
    const text = '- step\n\n  ```sh\n  a\n\n  b\n  ```\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['- step\n\n  ```sh\n  a\n\n  b\n  ```', 'After']);
  });

  test('keeps a loose bullet list together', () => {
    const text = 'Intro\n\n- one\n\n- two\n\n  continued two\n\n- three\n\nOutro';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '- one\n\n- two\n\n  continued two\n\n- three', 'Outro']);
  });

  test('keeps a loose ordered list and nested lists together', () => {
    const text = '1. one\n\n   - nested\n\n   - nested two\n\n2) two\n\n3. three';
    const blocks = expectSameRendering(text);
    expect(blocks.length).toBe(1);
  });

  test('a paragraph between lists splits, and numbering still renders the same', () => {
    const blocks = expectSameRendering('1. a\n\npara\n\n2. b');
    expect(blocks).toEqual(['1. a', 'para', '2. b']);
  });

  test('keeps a table in one block', () => {
    const text = 'Intro\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n\nOutro';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |', 'Outro']);
  });

  test('keeps blockquote chunks separated by blank lines together', () => {
    const text = '> first\n> line\n\n> second\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['> first\n> line\n\n> second', 'After']);
  });

  test('keeps an indented code block with blank lines together', () => {
    const text = 'Intro\n\n    code a\n\n    code b\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro\n\n    code a\n\n    code b', 'After']);
  });

  test('handles CRLF line endings', () => {
    const text = 'One\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\n- x\r\n\r\n- y\r\n\r\nEnd';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['One', '```\r\na\r\n\r\nb\r\n```', '- x\r\n\r\n- y', 'End']);
  });

  test('does not split text that uses reference-style link definitions', () => {
    const text = 'See [docs][d].\n\nMore text\n\n[d]: https://example.com';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual([text]);
  });

  test('does not split when a reference definition sits in a container or has a multi-line label', () => {
    const cases = [
      'See [docs][d].\n\n> [d]: https://example.com',
      'See [docs][d].\n\n- [d]: https://example.com',
      'See [docs][d].\n\n- item\n\n    [d]: https://example.com',
      'See [a\nb].\n\nMore text\n\n[a\nb]: https://example.com',
    ];
    for (const text of cases) {
      expect(expectSameRendering(text)).toEqual([text]);
    }
  });

  test('detects definitions behind nested prefixes and escaped brackets', () => {
    for (const text of [
      'Use [x].\n\n> 1. > * [x]: https://example.com',
      'Use [x\\]y].\n\nMore\n\n[x\\]y]: https://example.com',
      'Use [x].\n\n\t[x]: https://example.com',
    ]) {
      expect(expectSameRendering(text)).toEqual([text]);
    }
  });

  test('bracket text that is not a definition still splits', () => {
    expect(splitMarkdownBlocks('Slice a[1:] here\n\nNext')).toEqual(['Slice a[1:] here', 'Next']);
    expect(splitMarkdownBlocks('- [ ] task\n\nNext')).toEqual(['- [ ] task', 'Next']);
  });

  test('reference definition scanning stays linear', () => {
    const started = performance.now();
    splitMarkdownBlocks('[' + 'a'.repeat(50000) + '\n\n' + '- '.repeat(20000) + '[' + 'b'.repeat(5000));
    splitMarkdownBlocks(('[' + 'x'.repeat(998) + '\n').repeat(200));
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('an indented rule line inside a list item is not a separator', () => {
    const text = '- a\n  ---\n    b';
    expect(expectSameRendering(text)).toEqual([text]);
    expect(expectSameRendering('1. a\n\n   ***\n\n   b')).toEqual(['1. a\n\n   ***\n\n   b']);
  });

  test('a rule line indented 4 columns is not a separator', () => {
    expect(splitMarkdownBlocks('Text\n\n    ---\n\nNext')).toEqual(['Text\n\n    ---', 'Next']);
    const blocks = splitMarkdownBlocks('---\n    ---');
    expect(blocks).toEqual(['---', '    ---']);
    expect(blocks.map(isMarkdownSeparatorBlock)).toEqual([true, false]);
  });

  test('an unindented rule line still ends a list and becomes a separator', () => {
    expect(expectSameRendering('- a\n\n---\n\nb')).toEqual(['- a', '---', 'b']);
  });

  test('puts a horizontal rule on its own separator block', () => {
    const blocks = expectSameRendering('Above\n\n---\n\nBelow');
    expect(blocks).toEqual(['Above', '---', 'Below']);
    expect(blocks.map(isMarkdownSeparatorBlock)).toEqual([false, true, false]);
  });

  test('a rule directly under text is still a separator, not a setext heading', () => {
    expect(splitMarkdownBlocks('Above\n***\nBelow')).toEqual(['Above', '***', 'Below']);
    expect(splitMarkdownBlocks('Title\n---')).toEqual(['Title', '---']);
  });

  test('a rule inside a fence is code, not a separator', () => {
    const text = '```yaml\n---\nkey: 1\n---\n```';
    expect(splitMarkdownBlocks(text)).toEqual([text]);
  });

  test('a blockquoted fence line does not close a top-level fence', () => {
    expect(expectSameRendering('```js\n> ```\n\n+ plus\ntext')).toEqual(['```js\n> ```\n\n+ plus\ntext']);
  });

  test('a line that leaves a list item or blockquote ends the fence inside it', () => {
    expectSameRendering('- ```\n```\n\n> ```\npara\n| - | - |\n\n| - | - |');
    expect(expectSameRendering('> ```\n> a\n\n```\nb\n\nc')).toEqual(['> ```\n> a', '```\nb\n\nc']);
  });

  test('a 4-column indented fence line under a paragraph is not a fence opener', () => {
    expectSameRendering('more *text*\n    ```\n   ```\n\nSetext\n===');
    expectSameRendering('Title\n\n    ```\n  ```\n  - nested\n\ntail');
  });

  test('a fence in a list item indented past the marker closes at its own column', () => {
    const text = '- item\n\n    ```\n    a\n\n    b\n    ```\n\nAfter';
    expect(expectSameRendering(text)).toEqual(['- item\n\n    ```\n    a\n\n    b\n    ```', 'After']);
  });

  test('container-prefix scanning stays linear on adversarial lines', () => {
    const lines = ['>  '.repeat(8000) + 'x', '-   '.repeat(8000) + 'x', '1.  '.repeat(8000) + 'x'];
    const started = performance.now();
    for (const line of lines) {
      splitMarkdownBlocks(line);
      splitMarkdownBlocks('```\n' + line);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('random documents render the same split and whole', () => {
    const pieces = [
      'para text', '# Head', '- item', '  - nested', '1. one', '2) two', '   continued',
      '    indented code', '> quote', '>', '```', '```js', '~~~', '````', '  ```', '    ```',
      '| a | b |', '| - | - |', '| 1 | 2 |', '', '', '', '\t tab line', '* star', '1. Step',
      '   ```bash', '- ```', '> ```', '> - x', 'Setext\n===', '> ', '``` x `y`', 'a  ',
    ];
    let seed = 20260916;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 20000; i++) {
      const count = 2 + Math.floor(random() * 12);
      const lines: string[] = [];
      for (let j = 0; j < count; j++) lines.push(pieces[Math.floor(random() * pieces.length)]);
      const text = lines.join(random() < 0.1 ? '\r\n' : '\n').trimEnd();
      const { blocks, split, whole } = renderSplit(text);
      if (split !== whole) {
        throw new Error(`Split changed rendering for ${JSON.stringify(text)} -> ${JSON.stringify(blocks)}`);
      }
    }
  });

  test('appending streamed text only changes the last block', () => {
    const base =
      '# Plan\n\nIntro text\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nThe last paragraph';
    const before = splitMarkdownBlocks(base);
    const after = splitMarkdownBlocks(base + ' keeps growing with more words');
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length - 1; i++) {
      expect(after[i] === before[i]).toBe(true);
    }
    expect(after[after.length - 1]).toBe('The last paragraph keeps growing with more words');
  });
});

describe('isMarkdownSeparatorBlock', () => {
  test('matches rule lines only', () => {
    expect(isMarkdownSeparatorBlock('---')).toBe(true);
    expect(isMarkdownSeparatorBlock('  *****  ')).toBe(true);
    expect(isMarkdownSeparatorBlock('___')).toBe(true);
    expect(isMarkdownSeparatorBlock('    ---')).toBe(false);
    expect(isMarkdownSeparatorBlock('--')).toBe(false);
    expect(isMarkdownSeparatorBlock('- - -')).toBe(false);
    expect(isMarkdownSeparatorBlock('text\n---')).toBe(false);
  });
});
