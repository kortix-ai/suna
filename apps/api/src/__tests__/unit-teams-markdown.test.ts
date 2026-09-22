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

describe('markdownToCardElements — code', () => {
  test('a fenced block becomes a monospace TextBlock that keeps its line breaks', () => {
    const md = ['Structure:', '', '```', 'kaab-demo/', '├── README.md', '└── kortix.yaml', '```', '', 'Done.'].join('\n');
    const els = markdownToCardElements(md) as El[];
    expect(els).toHaveLength(3);
    expect(els[0]).toMatchObject({ type: 'TextBlock', text: 'Structure:' });
    expect(els[1]).toMatchObject({ type: 'TextBlock', fontType: 'Monospace', wrap: true });
    expect(els[1].text).toBe('kaab-demo/\n├── README.md\n└── kortix.yaml');
    expect(els[2]).toMatchObject({ type: 'TextBlock', text: 'Done.' });
  });

  test('markdown control characters inside a fenced block are escaped, not interpreted', () => {
    const md = ['```', 'const a = *b* + _c_;', 'x[0] = `y`', '```'].join('\n');
    const [code] = markdownToCardElements(md) as El[];
    expect(code.text).toBe('const a = \\*b\\* + \\_c\\_;\nx\\[0\\] = y');
  });

  test('inline code is rendered bold with the backticks removed', () => {
    const [p] = markdownToCardElements('- `README.md` — 3 lines\n- `kortix.yaml` — project config') as El[];
    expect(p.text).toBe('- **README.md** — 3 lines\n- **kortix.yaml** — project config');
  });

  test('an unterminated fence still renders as code to the end', () => {
    const els = markdownToCardElements('before\n\n```sh\nls -la') as El[];
    expect(els[1]).toMatchObject({ fontType: 'Monospace', text: 'ls -la' });
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
