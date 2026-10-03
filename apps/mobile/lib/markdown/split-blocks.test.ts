import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mathPlugin, type MathPluginHost } from './math-plugin';
import { isMarkdownSeparatorBlock, splitMarkdown, splitMarkdownBlocks } from './split-blocks';

// The exact markdown-it build react-native-markdown-display parses with, configured the
// way the chat renderer configures it. Rendering the whole text and rendering every block
// separately must produce the same HTML, or the split changed what the user sees.
const appRequire = createRequire(import.meta.url);
const rendererRequire = createRequire(
  realpathSync(appRequire.resolve('react-native-markdown-display/package.json')),
);
type MathToken = { content: string };
const MarkdownIt = rendererRequire('markdown-it') as (options: { typographer: boolean }) => MathPluginHost & {
  render: (source: string) => string;
  use: (plugin: (md: MathPluginHost) => void) => unknown;
  renderer: { rules: Record<string, (tokens: MathToken[], index: number) => string> };
};
const md = MarkdownIt({ typographer: true });
md.use(mathPlugin);
// markdown-it has no HTML for math tokens; print the TeX so a split that moves it shows.
md.renderer.rules.math_inline = (tokens, index) => `<m>${JSON.stringify(tokens[index].content)}</m>`;
md.renderer.rules.math_block = (tokens, index) => `<M>${JSON.stringify(tokens[index].content)}</M>\n`;

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

  test('keeps display math with blank lines in one block', () => {
    const text = 'Intro\n\n$$\na = 1\n\n\nb = 2\n$$\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '$$\na = 1\n\n\nb = 2\n$$', 'After']);
  });

  test('display math closes on a longer dollar run, not on a shorter one', () => {
    const text = '$$$\na\n$$\n\nb\n$$$$\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['$$$\na\n$$\n\nb\n$$$$', 'After']);
  });

  test('a one-line $$x$$ is inline math and splits like a paragraph', () => {
    const blocks = expectSameRendering('$$x$$\n\nNext');
    expect(blocks).toEqual(['$$x$$', 'Next']);
  });

  test('display math inside a list item keeps its blank lines', () => {
    const text = '- step\n\n  $$\n  a\n\n  b\n  $$\n\nAfter';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['- step\n\n  $$\n  a\n\n  b\n  $$', 'After']);
  });

  test('unclosed display math while streaming keeps everything after it in one block', () => {
    const text = 'Intro\n\n$$\n\\begin{aligned}\n\na &= b';
    const blocks = expectSameRendering(text);
    expect(blocks).toEqual(['Intro', '$$\n\\begin{aligned}\n\na &= b']);
    expect(splitMarkdown(text).endsInOpenFence).toBe(false);
  });

  test('dollars inside a fence do not open display math', () => {
    const text = '```\n$$\n```\n\nAfter';
    expect(expectSameRendering(text)).toEqual(['```\n$$\n```', 'After']);
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
      '$$', '$$$', '$$ meta', '  $$', '    $$', '> $$', '- $$', '$x$', '$$x$$', 'a $b', '$$ $',
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

describe('splitMarkdown endsInOpenFence', () => {
  test('is true only while the last fence has no closer', () => {
    expect(splitMarkdown('Intro\n\n```ts\nconst a = 1;').endsInOpenFence).toBe(true);
    expect(splitMarkdown('Intro\n\n```ts').endsInOpenFence).toBe(true);
    expect(splitMarkdown('Intro\n\n```ts\nconst a = 1;\n```').endsInOpenFence).toBe(false);
    expect(splitMarkdown('```ts\na\n```\n\nOutro').endsInOpenFence).toBe(false);
    expect(splitMarkdown('~~~\na\n```').endsInOpenFence).toBe(true);
    expect(splitMarkdown('No code here').endsInOpenFence).toBe(false);
  });

  test('a container fence ends when a line leaves the container', () => {
    expect(splitMarkdown('- step\n\n  ```sh\n  a').endsInOpenFence).toBe(true);
    expect(splitMarkdown('> ```\n> a').endsInOpenFence).toBe(true);
    expect(splitMarkdown('> ```\n> a\n\nOutside').endsInOpenFence).toBe(false);
  });

  test('reports the fence state for a single-block reference-definition message too', () => {
    const text = '[a]: https://kortix.com\n\n```ts\nconst a';
    expect(splitMarkdown(text)).toEqual({ blocks: [text], endsInOpenFence: true });
  });

  test('blocks match splitMarkdownBlocks', () => {
    const text = 'Intro\n\n```js\nfunction a() {}\n\n\nlet c';
    expect(splitMarkdown(text).blocks).toEqual(splitMarkdownBlocks(text));
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

describe('splitMarkdown while text streams', () => {
  /** A full scan, with no saved state to resume from. */
  const fullSplit = (text: string) => splitMarkdown(text, null);

  /** Feeds `text` in steps of `step` characters; every result equals a full scan. */
  function expectStreamingEqualsFull(text: string, step = 1) {
    const streamed: ReturnType<typeof splitMarkdown>[] = [];
    for (let end = 0; end <= text.length; end += step) streamed.push(splitMarkdown(text.slice(0, end)));
    let index = 0;
    for (let end = 0; end <= text.length; end += step) {
      const prefix = text.slice(0, end);
      const full = fullSplit(prefix);
      if (JSON.stringify(streamed[index]) !== JSON.stringify(full)) {
        throw new Error(`Streamed split differs for ${JSON.stringify(prefix)}: ${JSON.stringify(streamed[index])}`);
      }
      index += 1;
    }
  }

  const CORPUS = [
    '# Plan\n\nIntro text\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nThe last paragraph',
    'Math:\n\n$$\nx = 1\n\ny = 2\n$$\n\n$$$\na\n$$\nstill math\n$$$\n\nAfter $x$ text',
    '- step\n\n  ```sh\n  a\n\n  b\n  ```\n\n- next\n\n> quote\n>\n> ```\n> code\n\nOutside',
    'Text\n---\n\n***\n\n- a\n  ---\n\n    indented\n\n    code\n\npara\r\n\r\nCRLF para\r\n```\r\nx\r\n```\r\n',
    'Intro\n\n[ref]: https://kortix.com\n\nUses [a][ref]\n\n```\nunclosed',
    '~~~\n```\nnot closed by backticks\n~~~\n\n````\n```\ninner\n````\n\n1. one\n2) two\n\n   continued',
    '<div align="center">\n  <img src="a.png">\n\n</div>\n\nAfter the HTML block\n\n<!-- comment\n\nstill comment -->\n\nEnd',
    'See [the docs][docs] first.\n\nMore text\n\n- list\n\n[docs]: https://docs.example.com\n\nTail paragraph',
  ];

  test('every streamed prefix of the corpus equals a full scan', () => {
    for (const text of CORPUS) {
      expectStreamingEqualsFull(text);
      expectStreamingEqualsFull(text + '\n\n' + text, 3);
    }
  });

  test('random streamed documents equal a full scan', () => {
    const pieces = [
      'para text', '# Head', '- item', '  - nested', '1. one', '   continued', '    indented code', '> quote',
      '```', '```js', '~~~', '````', '    ```', '| a | b |', '| - | - |', '', '', '---', '$$', '$$$', '> $$',
      '- $$', '$x$', '[r]: https://x.co', '\t tab',
    ];
    let seed = 20261002;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let doc = 0; doc < 400; doc += 1) {
      const lines: string[] = [];
      const count = 2 + random(14);
      for (let i = 0; i < count; i += 1) lines.push(pieces[random(pieces.length)]);
      expectStreamingEqualsFull(lines.join(random(10) === 0 ? '\r\n' : '\n'), 1 + random(5));
    }
  });

  test('texts that stream side by side equal a full scan', () => {
    const texts = [CORPUS[0], CORPUS[2], CORPUS[3]];
    const longest = Math.max(...texts.map((text) => text.length));
    for (let end = 0; end <= longest; end += 2) {
      for (const text of texts) {
        const prefix = text.slice(0, end);
        expect(splitMarkdown(prefix)).toEqual(fullSplit(prefix));
      }
    }
  });

  test('a text that is not an extension of the previous one splits from scratch', () => {
    const a = 'First\n\n```\ncode\n\nmore';
    const b = 'First\n\nDifferent\n\nend';
    splitMarkdown(a);
    expect(splitMarkdown(b)).toEqual(fullSplit(b));
    splitMarkdown(b);
    expect(splitMarkdown(a)).toEqual(fullSplit(a));
  });
});
