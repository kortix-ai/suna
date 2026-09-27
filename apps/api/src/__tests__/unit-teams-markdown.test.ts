import { describe, expect, test } from 'bun:test';
import { markdownToCardElements } from '../channels/teams/markdown';

/**
 * The first live Teams answer on dev (2026-09-18, session 196a99f5…) rendered
 * a `teams send` body as ONE TextBlock. Teams' TextBlock markdown knows bold,
 * italic, lists and links — nothing else — so every `filename` span vanished
 * and a fenced directory tree lost its fences and its monospace font. These
 * pin the conversion of the agent's markdown into card elements.
 */

type El = Record<string, unknown>;

// Teams does not break a TextBlock at a single `\n` outside a list —
// Microsoft: "If you require newlines elsewhere in the TextBlock, use \n\n"
// (learn.microsoft.com, "Format cards in Teams", 2026-09). A fenced block sent
// as one monospace TextBlock ran its lines together; Microsoft's own renderer
// with the Teams host config shows the same. Teams has a native `CodeBlock`
// for this (web and desktop), and mobile gets the fallback.
describe('markdownToCardElements — code', () => {
  const code = (els: El[]) => els.find((e) => e.type === 'CodeBlock') as El & { fallback: El };

  test('a fenced block becomes a Teams CodeBlock that keeps its line breaks', () => {
    const md = ['Structure:', '', '```', 'kaab-demo/', '├── README.md', '└── kortix.yaml', '```', '', 'Done.'].join('\n');
    const els = markdownToCardElements(md) as El[];
    expect(els).toHaveLength(3);
    expect(els[0]).toMatchObject({ type: 'TextBlock', text: 'Structure:' });
    expect(els[1]).toMatchObject({ type: 'CodeBlock', language: 'PlainText' });
    expect(els[1].codeSnippet).toBe('kaab-demo/\n├── README.md\n└── kortix.yaml');
    expect(els[2]).toMatchObject({ type: 'TextBlock', text: 'Done.' });
  });

  test('the fence language picks the highlighter; an unknown one is plain text', () => {
    expect(code(markdownToCardElements('```ts\nconst a = 1;\n```') as El[]).language).toBe('TypeScript');
    expect(code(markdownToCardElements('```sh\nls -la\n```') as El[]).language).toBe('Bash');
    expect(code(markdownToCardElements('```python\nprint(1)\n```') as El[]).language).toBe('Python');
    expect(code(markdownToCardElements('```brainfuck\n+++\n```') as El[]).language).toBe('PlainText');
  });

  test('mobile, which has no CodeBlock, falls back to monospace with each line kept apart', () => {
    const block = code(markdownToCardElements('```\na\nb\n```') as El[]);
    expect(block.fallback).toMatchObject({ type: 'TextBlock', fontType: 'Monospace', wrap: true });
    // `\n\n` is the only line break Teams honours outside a list.
    expect(block.fallback.text).toBe('a\n\nb');
  });

  test('the snippet is the code verbatim; only the fallback escapes markdown', () => {
    const block = code(markdownToCardElements(['```', 'const a = *b* + _c_;', 'x[0] = `y`', '```'].join('\n')) as El[]);
    expect(block.codeSnippet).toBe('const a = *b* + _c_;\nx[0] = `y`');
    expect(block.fallback.text).toBe('const a = \\*b\\* + \\_c\\_;\n\nx\\[0\\] = y');
  });

  test('a long block keeps the whole snippet but a bounded fallback', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const block = code(markdownToCardElements(['```', ...lines, '```'].join('\n')) as El[]);
    expect(block.codeSnippet).toBe(lines.join('\n'));
    expect(String(block.fallback.text)).toContain('line 0');
    expect(String(block.fallback.text)).not.toContain('line 119');
    expect(String(block.fallback.text)).toContain('more lines');
  });

  test('inline code is rendered bold with the backticks removed', () => {
    const [p] = markdownToCardElements('- `README.md` — 3 lines\n- `kortix.yaml` — project config') as El[];
    expect(p.text).toBe('- **README.md** — 3 lines\n- **kortix.yaml** — project config');
  });

  test('an unterminated fence still renders as code to the end', () => {
    const els = markdownToCardElements('before\n\n```sh\nls -la') as El[];
    expect(els[1]).toMatchObject({ type: 'CodeBlock', codeSnippet: 'ls -la', language: 'Bash' });
  });
});

// Same rule for prose: "Deployed.\nVersion 1.2" ran together on one line in
// Teams where Slack shows two. Each prose line is its own block, tight to the
// line above; a run of list items stays one block, where `\n` does break.
describe('markdownToCardElements — line breaks', () => {
  test('each line of a paragraph is its own block, with no gap between them', () => {
    const els = markdownToCardElements('Deployed to prod.\nVersion: 1.2.3\nDuration: 4 min') as El[];
    expect(els.map((e) => e.text)).toEqual(['Deployed to prod.', 'Version: 1.2.3', 'Duration: 4 min']);
    expect(els[0].spacing).toBeUndefined();
    expect(els[1].spacing).toBe('none');
    expect(els[2].spacing).toBe('none');
  });

  test('a list stays one block, and prose around it keeps its own lines', () => {
    const els = markdownToCardElements('Found 2 files:\n- a.ts\n- b.ts\nBoth changed.') as El[];
    expect(els.map((e) => e.text)).toEqual(['Found 2 files:', '- a.ts\n- b.ts', 'Both changed.']);
  });

  test('a list item continued on an indented line stays in the list', () => {
    const [list] = markdownToCardElements('- first item\n  that wraps\n- second') as El[];
    expect(list.text).toBe('- first item\n  that wraps\n- second');
  });

  test('a separator above a multi-line paragraph lands on its first line only', () => {
    const els = markdownToCardElements('before\n\n---\n\none\ntwo') as El[];
    expect(els[1]).toMatchObject({ text: 'one', separator: true });
    expect(els[2].separator).toBeUndefined();
  });
});

describe('markdownToCardElements — structure', () => {
  test('headings become sized bold text and paragraphs stay paragraphs', () => {
    const els = markdownToCardElements('# Repo: kaab-demo\n\nFive files.\n\n## Details\n\nMore.') as El[];
    expect(els[0]).toMatchObject({ text: 'Repo: kaab-demo', weight: 'bolder', size: 'large' });
    expect(els[1]).toMatchObject({ text: 'Five files.' });
    expect(els[2]).toMatchObject({ text: 'Details', weight: 'bolder', size: 'medium' });
    expect(els[3]).toMatchObject({ text: 'More.' });
  });

  test('a pipe table becomes a Table with a header row', () => {
    const md = ['| File | Lines |', '|---|---|', '| README.md | 3 |', '| kortix.yaml | 12 |'].join('\n');
    const [table] = markdownToCardElements(md) as El[];
    expect(table.type).toBe('Table');
    const rows = table.rows as Array<{ cells: Array<{ items: El[] }> }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].cells[0].items[0]).toMatchObject({ text: 'File', weight: 'bolder' });
    expect(rows[2].cells[1].items[0]).toMatchObject({ text: '12' });
    expect(table.columns).toEqual([{ width: 1 }, { width: 1 }]);
  });

  test('a blockquote is subtle text and a rule becomes a separator on the next block', () => {
    const els = markdownToCardElements('> note\n\n---\n\nafter') as El[];
    expect(els[0]).toMatchObject({ text: 'note', isSubtle: true });
    expect(els[1]).toMatchObject({ text: 'after', separator: true });
  });

  test('bullet lists and links pass through untouched — Teams renders those natively', () => {
    const md = '- one\n- two [docs](https://kortix.com)\n\n1. first\n2. second';
    const els = markdownToCardElements(md) as El[];
    expect(els).toHaveLength(2);
    expect(els[0].text).toBe('- one\n- two [docs](https://kortix.com)');
    expect(els[1].text).toBe('1. first\n2. second');
  });

  test('empty input yields no elements; whitespace-only likewise', () => {
    expect(markdownToCardElements('')).toEqual([]);
    expect(markdownToCardElements('  \n\n ')).toEqual([]);
  });
});

describe('markdownToCardElements — HTML entities', () => {
  test('entities that leak into the text are decoded, not shown literally (dev: "I&#39;ll take a look")', () => {
    const [p] = markdownToCardElements("Once it&#39;s attached, I&#39;ll take a look &amp; reply &lt;soon&gt; &quot;ok&quot;") as El[];
    expect(p.text).toBe(`Once it's attached, I'll take a look & reply <soon> "ok"`);
  });
});
