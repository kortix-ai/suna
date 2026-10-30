import { describe, expect, test } from 'bun:test';

import { rehypeStreamWords, STREAM_WORD_CLASS } from './stream-words';

const text = (value: string) => ({ type: 'text', value });
const el = (tagName: string, children: unknown[], className?: string[]) => ({
  type: 'element',
  tagName,
  properties: className ? { className } : {},
  children,
});

describe('rehypeStreamWords', () => {
  test('wraps each prose word in a stream-word span and keeps whitespace as text', () => {
    const tree = { type: 'root', children: [el('p', [text('Hello  world\n'), el('strong', [text('bold')])])] };
    rehypeStreamWords()(tree as never);
    const p = tree.children[0] as ReturnType<typeof el>;
    expect(p.children).toEqual([
      el('span', [text('Hello')], [STREAM_WORD_CLASS]),
      text('  '),
      el('span', [text('world')], [STREAM_WORD_CLASS]),
      text('\n'),
      el('strong', [el('span', [text('bold')], [STREAM_WORD_CLASS])]),
    ]);
  });

  test('leaves code, pre and KaTeX text untouched', () => {
    const code = el('pre', [el('code', [text('const x = 1')])]);
    const inline = el('code', [text('a b')]);
    const katex = el('span', [text('x + y')], ['katex']);
    const tree = { type: 'root', children: [code, el('p', [inline, katex])] };
    rehypeStreamWords()(tree as never);
    expect(tree.children[0]).toEqual(el('pre', [el('code', [text('const x = 1')])]));
    expect(tree.children[1]).toEqual(el('p', [el('code', [text('a b')]), el('span', [text('x + y')], ['katex'])]));
  });
});
