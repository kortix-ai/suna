import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Renders the real `MarkdownTable` from the library's real AST on the iOS path
// (`UITextView`). Every native module is a host stub. Run with `bun test --isolate`.
type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;
const noop = () => {};
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style ?? {}) as Record<string, unknown>);

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s },
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  LogBox: { ignoreLogs: noop },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  UIManager: { hasViewManagerConfig: () => true },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('react-native-uitextview', () => ({ UITextView: host('uitextview') }));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated-view') }, Easing: { bezier: () => 0 }, Keyframe: class { duration() { return this; } } }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: none, BottomSheetView: none, TouchableOpacity: none }));
mock.module('react-native-markdown-display', () => ({ default: none, MarkdownIt: () => ({ use: () => ({}) }) }));
mock.module('@expensify/react-native-live-markdown/src/MarkdownTextInput', () => ({ default: none }));
mock.module('expo-haptics', () => ({}));
mock.module('expo-clipboard', () => ({}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('@/lib/icons', () => ({ CopyIcon: none }));
mock.module('@/lib/utils/live-markdown-config', () => ({ markdownParser: noop, lightMarkdownStyle: {}, darkMarkdownStyle: {} }));
// Any theme token path resolves; the table test reads no colour value.
const tokens = (): unknown => new Proxy(() => '#000', { get: (_t, key) => (key === Symbol.toPrimitive ? () => '#000' : tokens()) });
mock.module('@/lib/utils/theme', () => ({ MOTION: { easing: { out: [0, 0, 1, 1] }, duration: { moderate: 200 } }, THEME: tokens(), withAlpha: (c: string) => c }));
mock.module('@/lib/utils/fonts', () => ({ FONT_FAMILY: { regular: 'regular', medium: 'medium', semibold: 'semibold' } }));
mock.module('@/lib/logger', () => ({ log: { error: noop, warn: noop, info: noop } }));
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: none }));
mock.module('@/components/ui/button', () => ({ Button: none }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@kortix/shared', () => ({
  isMathFenceLanguage: () => false,
  isMermaidCode: () => false,
  prepareMarkdownForMath: (s: string) => s,
}));
mock.module('@/components/markdown/code-block', () => ({ CodeBlock: none, fenceCode: String, fenceLanguage: String }));
mock.module('@/components/markdown/inline-code', () => ({ InlineCode: host('inline-code') }));
mock.module('@/components/markdown/math', () => ({ BlockMath: none, InlineMath: host('inline-math') }));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock: none }));
mock.module('@/components/markdown/markdown-image', () => ({
  MarkdownImage: none,
  MarkdownImageGallery: none,
  MarkdownImagesContext: React.createContext(null),
}));
mock.module('@/lib/markdown/markdown-image', () => ({ groupImageBlocks: noop, imageSourceKey: String }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));

const appRequire = createRequire(import.meta.url);
const libraryRoot = realpathSync(join(appRequire.resolve('react-native-markdown-display/package.json'), '..'));
const MarkdownIt = createRequire(join(libraryRoot, 'package.json'))('markdown-it') as (o: { typographer: boolean }) => unknown;

type Ast = { type: string; children: Ast[] };
let parser: (source: string, renderer: (nodes: Ast[]) => unknown, md: unknown) => Ast[];
let MarkdownTable: typeof import('./selectable-markdown').MarkdownTable;
let markdownPalette: typeof import('@/components/markdown/markdown-theme').markdownPalette;
let tree: ReactTestRenderer | undefined;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  parser = (await import(join(libraryRoot, 'src/lib/parser.js'))).default;
  ({ MarkdownTable } = await import('./selectable-markdown'));
  ({ markdownPalette } = await import('@/components/markdown/markdown-theme'));
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

/** Renders the table and returns its rows: each row's cell Views and their text nodes. */
function renderRows(markdown: string) {
  const table = parser(markdown, (nodes) => nodes, MarkdownIt({ typographer: true })).find((n) => n.type === 'table');
  if (!table) throw new Error('no table in AST');
  act(() => {
    tree = create(<MarkdownTable node={table as never} palette={markdownPalette(false)} isDark={false} />);
  });
  const root = tree!.root;
  const rows = root.findAll((n) => n.type === 'view' && flatten(n.props.style).flexDirection === 'row');
  return rows.map((row) =>
    row.children.map((cell) => {
      const view = cell as (typeof rows)[number];
      return { style: flatten(view.props.style), text: view.findByType('uitextview' as never) };
    }),
  );
}

const ALIGNED = [
  '| Name | Status | Count |',
  '|:-----|:------:|------:|',
  '| `inline_code_value` | [a link](https://example.com) | 1 |',
  `| ${'a very long cell that must wrap inside its column '.repeat(6)} | **bold** | 333 |`,
].join('\n');

test('GFM columns render their alignment on every cell text node, header included', () => {
  const rows = renderRows(ALIGNED);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.map((c) => flatten(c.text.props.style).textAlign)).toEqual(['left', 'center', 'right']);
  }
});

test('a table without alignment markers is left-aligned, with inline code, a link and bold', () => {
  const rows = renderRows('| a | b |\n|---|---|\n| `x` | [l](https://example.com) |\n| **b** | plain |');
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.map((c) => flatten(c.text.props.style).textAlign)).toEqual(['left', 'left']);
  }
  const body = rows[1][0].text;
  expect(body.findAllByType('inline-code' as never)).toHaveLength(1);
  expect(rows[1][1].text.findAllByType('uitextview' as never).filter((n) => n.props.accessibilityRole === 'link')).toHaveLength(1);
});

test('every cell in a column has the same flexBasis, header and body, and the long cell is capped', () => {
  const rows = renderRows(ALIGNED);
  const bases = [0, 1, 2].map((col) => rows.map((row) => row[col].style.flexBasis));
  for (const column of bases) {
    expect(typeof column[0]).toBe('number');
    expect(new Set(column).size).toBe(1);
  }
  // 240 (body text cap) + 2 * TABLE_CELL_PADDING_X, narrower columns stay narrower.
  expect(bases[0][0] as number).toBeGreaterThan(240);
  expect(bases[2][0] as number).toBeLessThan(bases[0][0] as number);
  for (const row of rows) for (const cell of row) expect(cell.style.flexShrink).toBe(0);
});
