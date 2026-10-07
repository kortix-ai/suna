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
mock.module('expo-linear-gradient', () => ({ LinearGradient: host('linear-gradient') }));
mock.module('react-native-reanimated', () => ({ default: { View: host('animated-view') }, Easing: { bezier: () => 0 }, Keyframe: class { duration() { return this; } } }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetModal: none, BottomSheetView: none, TouchableOpacity: none }));
// The renderer stub reports the table surface it would hand to `MarkdownTable`.
mock.module('react-native-markdown-display', () => ({
  default: () => React.createElement('markdown', { surface: React.useContext(MarkdownSurfaceContext) }),
  MarkdownIt: () => ({ use: () => ({}) }),
}));
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
mock.module('@/lib/markdown/markdown-image', () => ({ groupImageBlocks: (blocks: string[]) => blocks.map((text, index) => ({ kind: 'markdown', index, text })), imageSourceKey: String }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));

const appRequire = createRequire(import.meta.url);
const libraryRoot = realpathSync(join(appRequire.resolve('react-native-markdown-display/package.json'), '..'));
const MarkdownIt = createRequire(join(libraryRoot, 'package.json'))('markdown-it') as (o: { typographer: boolean }) => unknown;

type Ast = { type: string; children: Ast[] };
let parser: (source: string, renderer: (nodes: Ast[]) => unknown, md: unknown) => Ast[];
let MarkdownTable: typeof import('./selectable-markdown').MarkdownTable;
let SelectableMarkdownText: typeof import('./selectable-markdown').SelectableMarkdownText;
let MarkdownSurfaceContext: typeof import('./selectable-markdown').MarkdownSurfaceContext;
let markdownPalette: typeof import('@/components/markdown/markdown-theme').markdownPalette;
let tree: ReactTestRenderer | undefined;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  parser = (await import(join(libraryRoot, 'src/lib/parser.js'))).default;
  ({ MarkdownTable, SelectableMarkdownText, MarkdownSurfaceContext } = await import('./selectable-markdown'));
  ({ markdownPalette } = await import('@/components/markdown/markdown-theme'));
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

let renders = 0;
// One palette for the render and the assertions: the stub THEME mints a new token per read.
let palette: ReturnType<typeof markdownPalette>;

function renderTable(markdown: string, surface?: string) {
  const table = parser(markdown, (nodes) => nodes, MarkdownIt({ typographer: true })).find((n) => n.type === 'table');
  if (!table) throw new Error('no table in AST');
  renders = 0;
  palette = markdownPalette(false);
  act(() => {
    tree = create(
      <React.Profiler id="table" onRender={() => renders++}>
        <MarkdownSurfaceContext.Provider value={surface}>
          <MarkdownTable node={table as never} palette={palette} isDark={false} />
        </MarkdownSurfaceContext.Provider>
      </React.Profiler>,
    );
  });
  return tree!.root;
}

/** Renders the table and returns its rows: each row's style, cell Views and their text nodes. */
function renderRows(markdown: string) {
  const root = renderTable(markdown);
  const rows = root.findAll((n) => n.type === 'view' && flatten(n.props.style).flexDirection === 'row');
  return rows.map((row) =>
    Object.assign(
      row.children.map((cell) => {
        const view = cell as (typeof rows)[number];
        return { style: flatten(view.props.style), text: view.findByType('uitextview' as never) };
      }),
      { rowStyle: flatten(row.props.style) },
    ),
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

test('each cell anchors its text at the column edge: left by default, centre and right for GFM columns', () => {
  for (const row of renderRows(ALIGNED)) {
    expect(row.map((c) => c.style.alignItems)).toEqual(['flex-start', 'center', 'flex-end']);
  }
  for (const row of renderRows('| a | b |\n|---|---|\n| 1 | 2 |')) {
    expect(row.map((c) => c.style.alignItems)).toEqual(['flex-start', 'flex-start']);
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

test('every cell in a column has the same whole-point width, header and body, and the long cell is capped', () => {
  const rows = renderRows(ALIGNED);
  const widths = [0, 1, 2].map((col) => rows.map((row) => row[col].style.width));
  for (const column of widths) {
    expect(Number.isInteger(column[0])).toBe(true);
    expect(new Set(column).size).toBe(1);
  }
  // 240 (body text cap) + 2 * TABLE_CELL_PADDING_X, narrower columns stay narrower.
  expect(widths[0][0] as number).toBeGreaterThan(240);
  expect(widths[2][0] as number).toBeLessThan(widths[0][0] as number);
  for (const row of rows) for (const cell of row) expect(cell.style.flexGrow).toBeUndefined();
});

test('a row with a missing cell still has every column, so the dividers stay in one line', () => {
  const rows = renderRows('| a | b | c |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 |');
  expect(rows.map((r) => r.length)).toEqual([3, 3, 3]);
  for (const col of [0, 1, 2]) expect(new Set(rows.map((r) => r[col].style.width)).size).toBe(1);
  expect(rows.map((r) => r[2].style.borderLeftWidth)).toEqual([0.5, 0.5, 0.5]);
});

test('the table draws a full grid: a rounded outer border, a divider above every row after the first and left of every column after the first', () => {
  const root = renderTable(ALIGNED);
  const frame = flatten(hostParent(root.findByType('gh-scroll' as never)).props.style);
  expect(frame).toMatchObject({ borderWidth: 0.5, borderColor: palette.border, borderRadius: 6, overflow: 'hidden' });

  const rows = renderRows(ALIGNED);
  expect(rows.map((r) => r.rowStyle.borderTopWidth)).toEqual([0, 0.5, 0.5]);
  for (const row of rows) {
    expect(row.rowStyle.borderTopColor).toBe(palette.border);
    expect(row.map((c) => c.style.borderLeftWidth)).toEqual([0, 0.5, 0.5]);
    for (const cell of row) expect(cell.style.borderLeftColor).toBe(palette.border);
  }
});

type Node = ReturnType<typeof renderTable>;
/** The nearest host element above `node` (the stubs wrap every host in a function component). */
function hostParent(node: Node): Node {
  let parent = node.parent;
  while (parent && typeof parent.type !== 'string') parent = parent.parent;
  return parent!;
}

const fades = (root: ReturnType<typeof renderTable>) =>
  ['left', 'right'].filter((side) => root.findAll((n) => n.props.testID === `table-fade-${side}` && typeof n.type === 'string').length > 0);

function scrollTo(root: ReturnType<typeof renderTable>, x: number, content: number, viewport: number) {
  act(() => {
    root.findByType('gh-scroll' as never).props.onScroll({
      nativeEvent: { contentOffset: { x, y: 0 }, contentSize: { width: content, height: 100 }, layoutMeasurement: { width: viewport, height: 100 } },
    });
  });
}

test('a table that fits its viewport shows no edge fade', () => {
  const root = renderTable(ALIGNED);
  const scroll = root.findByType('gh-scroll' as never);
  act(() => {
    scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 100 } } });
    scroll.props.onContentSizeChange(300, 100);
  });
  expect(fades(root)).toEqual([]);
});

test('a wider table fades its right edge at the start, both edges mid-scroll, and only the left edge at the end', () => {
  const root = renderTable(ALIGNED);
  const scroll = root.findByType('gh-scroll' as never);
  expect(scroll.props.scrollEventThrottle).toBe(16);
  act(() => {
    scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 100 } } });
    scroll.props.onContentSizeChange(700, 100);
  });
  expect(fades(root)).toEqual(['right']);

  scrollTo(root, 150, 700, 300);
  expect(fades(root)).toEqual(['left', 'right']);

  // Further frames that flip no edge do not re-render the table.
  const before = renders;
  scrollTo(root, 160, 700, 300);
  scrollTo(root, 200, 700, 300);
  expect(renders).toBe(before);

  scrollTo(root, 400, 700, 300);
  expect(fades(root)).toEqual(['left']);

  scrollTo(root, 0, 700, 300);
  expect(fades(root)).toEqual(['right']);
});

test('the fade is clipped by the frame, takes no touches, and fades the header row from the header colour', () => {
  const root = renderTable(ALIGNED);
  const scroll = root.findByType('gh-scroll' as never);
  const header = root.findAll((n) => n.type === 'view' && flatten(n.props.style).flexDirection === 'row')[0];
  act(() => {
    header.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 32 } } });
    scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 100 } } });
    scroll.props.onContentSizeChange(700, 100);
  });
  const fade = root.find((n) => n.props.testID === 'table-fade-right' && typeof n.type === 'string');
  expect(hostParent(fade)).toBe(hostParent(scroll));
  expect(fade.props.pointerEvents).toBe('none');
  expect(flatten(fade.props.style)).toMatchObject({ position: 'absolute', right: 0, top: 0, bottom: 0, width: 24 });
  const [headerFade, bodyFade] = fade.findAllByType('linear-gradient' as never);
  expect(flatten(headerFade.props.style).height).toBe(32);
  // Opaque at the edge (the last stop on the right side).
  expect(headerFade.props.colors.at(-1)).toBe(palette.tableHeader);
  expect(bodyFade.props.colors.at(-1)).toBe(palette.tableBody);
});

test('on another surface the frame fill and the body fades take that surface colour; the header fade keeps the header colour', () => {
  const root = renderTable(ALIGNED, 'hsl(0 0% 7.8%)');
  const scroll = root.findByType('gh-scroll' as never);
  const header = root.findAll((n) => n.type === 'view' && flatten(n.props.style).flexDirection === 'row')[0];
  act(() => {
    header.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 32 } } });
    scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 100 } } });
    scroll.props.onContentSizeChange(700, 100);
  });
  scrollTo(root, 150, 700, 300);
  expect(flatten(hostParent(scroll).props.style).backgroundColor).toBe('hsl(0 0% 7.8%)');
  for (const side of ['left', 'right']) {
    const fade = root.find((n) => n.props.testID === `table-fade-${side}` && typeof n.type === 'string');
    const [headerFade, bodyFade] = fade.findAllByType('linear-gradient' as never);
    expect(headerFade.props.colors).toContain(palette.tableHeader);
    expect(bodyFade.props.colors).toContain('hsl(0 0% 7.8%)');
    expect(bodyFade.props.colors).not.toContain(palette.tableBody);
  }
});

test('SelectableMarkdownText hands its surface to the tables inside it, and none by default', () => {
  act(() => {
    tree = create(<SelectableMarkdownText isDark={false} surface="hsl(0 0% 7.8%)">{'| a |\n|---|\n| b |'}</SelectableMarkdownText>);
  });
  expect(tree!.root.findByType('markdown' as never).props.surface).toBe('hsl(0 0% 7.8%)');
  act(() => tree!.update(<SelectableMarkdownText isDark={false}>{'| a |\n|---|\n| b |'}</SelectableMarkdownText>));
  expect(tree!.root.findByType('markdown' as never).props.surface).toBeUndefined();
});
