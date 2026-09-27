import { describe, expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { prepareMarkdownForMath } from '@kortix/shared';
import { mathPlugin, type MathPluginHost } from './math-plugin';

// The markdown-it build react-native-markdown-display parses with, configured
// the way the chat renderer configures it.
const appRequire = createRequire(import.meta.url);
const rendererRequire = createRequire(
  realpathSync(appRequire.resolve('react-native-markdown-display/package.json'))
);
type Token = { type: string; content: string; children: Token[] | null };
const MarkdownIt = rendererRequire('markdown-it') as (options: {
  typographer: boolean;
}) => MathPluginHost & {
  use(plugin: (md: MathPluginHost) => void): unknown;
  parse(source: string, env: object): Token[];
};
const md = MarkdownIt({ typographer: true });
md.use(mathPlugin);

/** Math nodes in document order: `I:` inline, `B:` block, with their TeX. */
function mathNodes(source: string): string[] {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'math_block') out.push(`B:${token.content}`);
      if (token.type === 'math_inline') out.push(`I:${token.content}`);
      if (token.children) walk(token.children);
    }
  };
  walk(md.parse(source, {}));
  return out;
}

// Generated from web's parser: unified + remark-parse 11 + remark-gfm 4 +
// remark-math 6 with `singleDollarTextMath: true` (apps/web katexRemarkPlugins).
const REMARK_MATH_CASES: [string, string[]][] = [
  ['Energy $E = mc^2$ here', ['I:E = mc^2']],
  ['Energy $ E = mc^2 $ here', ['I:E = mc^2']],
  ['Sum is $$\\sum x$$ ok', ['I:\\sum x']],
  ['$$\\sum_{i} x_i$$', ['I:\\sum_{i} x_i']],
  ['$$\n\\int_0^1 x\\,dx\n$$', ['B:\\int_0^1 x\\,dx']],
  ['$$\na\n\nb\n$$', ['B:a\n\nb']],
  ['Text\n\n$$\n\\frac{a}{b', ['B:\\frac{a}{b']],
  ['Energy $E = mc^2', []],
  ['a \\$5 and $6$ b', ['I:6']],
  ['price \\$5 and $x$', ['I:x']],
  ['`$x$` and $y$', ['I:y']],
  ['$$$x$$$', ['I:x']],
  ['Text\n$$\nx\n$$\nafter', ['B:x']],
  ['- item $a_1$\n- item\n\n  $$\n  b\n  $$', ['I:a_1', 'B:b']],
  ['> quote $q$', ['I:q']],
  ['$a$$b$', ['I:a$$b']],
  ['$x$y$', ['I:x']],
  ['multi $a\nb$ line', ['I:a\nb']],
  ['| a | $b$ |\n|---|---|\n| $c|d$ | e |', ['I:b']],
  ['$$ meta\nx\n$$', ['B:x']],
  ['  $$\n  x\n  $$', ['B:x']],
  ['$$\nx\n$$$', ['B:x']],
  ['a $$b$ c$$ d', ['I:b$ c']],
  ['**bold $x^2$**', ['I:x^2']],
  ['[link $x$](http://a)', ['I:x']],
  ['$\\$$', []],
  ['end with $', []],
];

describe('mathPlugin matches remark-math (web)', () => {
  test.each(REMARK_MATH_CASES)('%j', (source, expected) => {
    expect(mathNodes(source)).toEqual(expected);
  });

  test('covers 27 cases', () => {
    expect(REMARK_MATH_CASES).toHaveLength(27);
  });

  // Re-derives the fixtures from web's installed parser when apps/web is installed.
  const streamdownPackage = path.resolve(
    import.meta.dir,
    '../../../web/node_modules/streamdown/package.json'
  );
  test.skipIf(!existsSync(streamdownPackage))(
    'fixtures equal the live remark-math output',
    async () => {
      const webRequire = createRequire(realpathSync(streamdownPackage));
      const load = async (name: string) => import(webRequire.resolve(name));
      const { unified } = await load('unified');
      const remarkParse = (await load('remark-parse')).default;
      const remarkGfm = (await load('remark-gfm')).default;
      const remarkMath = (await load('remark-math')).default;
      type MdastNode = { type: string; value?: string; children?: MdastNode[] };
      for (const [source, expected] of REMARK_MATH_CASES) {
        const processor = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .use(remarkMath, { singleDollarTextMath: true });
        const tree = processor.runSync(processor.parse(source)) as MdastNode;
        const nodes: string[] = [];
        const walk = (node: MdastNode) => {
          if (node.type === 'math') nodes.push(`B:${node.value}`);
          if (node.type === 'inlineMath') nodes.push(`I:${node.value}`);
          node.children?.forEach(walk);
        };
        walk(tree);
        expect(nodes).toEqual(expected);
      }
    }
  );
});

describe('mathPlugin tokens', () => {
  test('inline math stays inside the paragraph inline token', () => {
    const tokens = md.parse('a $x$ b', {});
    expect(tokens.map((t) => t.type)).toEqual(['paragraph_open', 'inline', 'paragraph_close']);
    expect(tokens[1].children?.map((t) => t.type)).toEqual(['text', 'math_inline', 'text']);
  });

  test('a block is a top-level math_block token between paragraphs', () => {
    const tokens = md.parse('before\n\n$$\nx^2\n$$\n\nafter', {});
    expect(tokens.map((t) => t.type)).toEqual([
      'paragraph_open',
      'inline',
      'paragraph_close',
      'math_block',
      'paragraph_open',
      'inline',
      'paragraph_close',
    ]);
  });

  test('a fence with math inside is still code', () => {
    expect(mathNodes('```\n$x$\n$$\ny\n$$\n```')).toEqual([]);
  });

  test('inline code keeps its dollars', () => {
    expect(mathNodes('`$$` and `$x$`')).toEqual([]);
  });
});

describe('streaming', () => {
  test('an unclosed display block renders what has arrived', () => {
    expect(mathNodes('Result:\n\n$$\n\\int_0^1 x')).toEqual(['B:\\int_0^1 x']);
    expect(mathNodes('$$')).toEqual(['B:']);
  });

  test('an unclosed inline formula stays text', () => {
    const tokens = md.parse('Energy $E = mc', {});
    expect(mathNodes('Energy $E = mc')).toEqual([]);
    expect(tokens[1].children?.map((t) => t.content).join('')).toBe('Energy $E = mc');
  });
});

describe('with prepareMarkdownForMath', () => {
  test('currency never pairs with real math', () => {
    expect(mathNodes(prepareMarkdownForMath('It costs $4M and $50K, and $x$'))).toEqual(['I:x']);
  });

  test('\\( \\) and \\[ \\] delimiters become inline and display math', () => {
    expect(
      mathNodes(prepareMarkdownForMath('Inline \\(a+b\\) and display \\[\\frac{1}{2}\\]'))
    ).toEqual(['I:a+b', 'B:\\frac{1}{2}']);
  });
});

describe('react-native-markdown-display AST', () => {
  type AstNode = { type: string; content?: string; children: AstNode[] };
  const displayParser = rendererRequire('./src/lib/parser.js') as {
    default: (
      source: string,
      renderer: (nodes: AstNode[]) => AstNode[],
      markdownIt: unknown
    ) => AstNode[];
  };
  const ast = (source: string) => displayParser.default(source, (nodes) => nodes, md);
  const shape = (nodes: AstNode[]): unknown =>
    nodes.map((node) => (node.children.length ? { [node.type]: shape(node.children) } : node.type));

  test('inline math is a leaf inside the textgroup, so it inherits text styles', () => {
    expect(shape(ast('Energy $E = mc^2$ and **$x$**'))).toEqual([
      { paragraph: [{ textgroup: ['text', 'math_inline', 'text', { strong: ['math_inline'] }] }] },
    ]);
  });

  test('display math is a top-level block node with its TeX', () => {
    const nodes = ast('Before\n\n$$\n\\frac{a}{b}\n$$');
    expect(nodes.map((node) => node.type)).toEqual(['paragraph', 'math_block']);
    expect(nodes[1].content).toBe('\\frac{a}{b}');
  });
});
