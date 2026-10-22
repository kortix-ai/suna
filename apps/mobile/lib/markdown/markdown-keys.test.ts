import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mathPlugin, type MathPluginHost } from './math-plugin';

/**
 * `patches/react-native-markdown-display+7.0.2.patch`: AST keys are the node's
 * path, not a global counter. The library re-parses on every render, so with
 * counter keys every streaming tick remounted the whole block's native views.
 * These run the library's own parser and renderer, as patched in node_modules.
 */

// AstRenderer imports StyleSheet; nothing here reaches it with a style to flatten.
mock.module('react-native', () => ({ StyleSheet: { flatten: (style: unknown) => style } }));

const appRequire = createRequire(import.meta.url);
const libraryRoot = realpathSync(join(appRequire.resolve('react-native-markdown-display/package.json'), '..'));
const rendererRequire = createRequire(join(libraryRoot, 'package.json'));
const MarkdownIt = rendererRequire('markdown-it') as (options: { typographer: boolean }) => MathPluginHost & {
  use: (plugin: (md: MathPluginHost) => void) => unknown;
};
const md = MarkdownIt({ typographer: true });
md.use(mathPlugin);

type AstNode = { key: string; type: string; children: AstNode[] };
type Parser = (source: string, renderer: (nodes: AstNode[]) => unknown, markdownIt: unknown) => unknown;
type AstRendererClass = new (rules: Record<string, (node: AstNode) => unknown>, style: object) => {
  render: (nodes: AstNode[]) => unknown;
};

let parser: Parser;
let AstRenderer: AstRendererClass;

beforeAll(async () => {
  parser = (await import(join(libraryRoot, 'src/lib/parser.js'))).default;
  AstRenderer = (await import(join(libraryRoot, 'src/lib/AstRenderer.js'))).default;
});

function ast(source: string): AstNode[] {
  return parser(source, (nodes) => nodes, md) as AstNode[];
}

/** Every node's key, depth first, with its type. */
function keys(nodes: AstNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.key);
    keys(node.children, out);
  }
  return out;
}

function expectSiblingKeysUnique(nodes: AstNode[]) {
  expect(new Set(nodes.map((node) => node.key)).size).toBe(nodes.length);
  for (const node of nodes) expectSiblingKeysUnique(node.children);
}

const SAMPLE = [
  '# Title',
  '',
  'A paragraph with',
  'softbreaks between',
  'its lines, and a hard break  ',
  'here.',
  '',
  '<div align="center">',
  '  <b>html block</b>',
  '</div>',
  '',
  'Some **bold** and *em* text with `code`, $x^2$ and a [link](https://kortix.com).',
  '',
  '- one',
  '- two with ![img](https://example.com/a.png)',
  '  - nested',
  '',
  '> quote',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '$$',
  'x = y',
  '$$',
].join('\n');

describe('react-native-markdown-display AST keys (patched)', () => {
  test('the same markdown parses to the same keys every time', () => {
    const first = keys(ast(SAMPLE));
    const second = keys(ast(SAMPLE));
    expect(first.length).toBeGreaterThan(20);
    expect(second).toEqual(first);
    // Not the old counter keys (`rnmr_<hex>_<type>`).
    expect(first.some((key) => key.startsWith('rnmr_'))).toBe(false);
  });

  test('keys are unique among siblings and name the node type', () => {
    const nodes = ast(SAMPLE);
    expectSiblingKeysUnique(nodes);
    // The sample covers sibling runs of the same type: softbreaks between text nodes.
    expect(keys(nodes).filter((key) => key.endsWith('_softbreak')).length).toBeGreaterThanOrEqual(2);
    const walk = (list: AstNode[]) => {
      for (const node of list) {
        expect(node.key.endsWith(`_${node.type}`)).toBe(true);
        walk(node.children);
      }
    };
    walk(nodes);
  });

  test('appending to the last paragraph keeps every earlier key', () => {
    const before = ast('First paragraph.\n\nSecond **bold** paragraph that');
    const after = ast('First paragraph.\n\nSecond **bold** paragraph that keeps growing, now with `code`.');
    const beforeKeys = keys(before);
    const afterKeys = keys(after);
    // Every node that existed keeps its key; the new inline nodes are added after them.
    expect(afterKeys.slice(0, beforeKeys.length)).toEqual(beforeKeys);
    expect(afterKeys.length).toBeGreaterThan(beforeKeys.length);
  });

  test('appending a new block keeps the keys of the blocks before it', () => {
    const before = ast('- one\n- two');
    const after = ast('- one\n- two\n- three\n\nNext paragraph.');
    const beforeKeys = keys(before);
    expect(keys(after).filter((key) => beforeKeys.includes(key))).toEqual(beforeKeys);
  });

  test('the root body node has a fixed key', () => {
    const rules = { body: (node: AstNode) => node.key, unknown: () => null };
    const render = (source: string) => new AstRenderer(rules, {}).render(ast(source));
    expect(render('a')).toBe('body');
    expect(render('a b c')).toBe('body');
  });
});
