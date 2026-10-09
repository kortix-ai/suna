/**
 * The shared diff-row paint, characterized through both of today's copies:
 * ReviewFileDiff's row (gutter 44, content paddingRight 12, paddingVertical 1,
 * hunk lines unprefixed) and PatchDiffView's DiffFile row (gutter 42, content
 * paddingRight 14, minHeight 18, hunk lines prefixed with a space). They agree
 * on kind colors (add/del/hunk backgrounds and glyphs) and the `+ ` / `− `
 * sign prefixes. The KRTX-1292 dedupe converges the two-pixel deltas; this
 * file's expectations move with that disclosed change.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

mock.module('react-native', () => ({
  View: host('view'),
  ScrollView: host('scroll'),
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('@gorhom/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data, renderItem, ListEmptyComponent }: { data?: unknown[]; renderItem: (p: { item: unknown }) => React.ReactElement; ListEmptyComponent?: React.ReactElement }) => (
    <>
      {data?.length ? data.map((item, i) => <React.Fragment key={i}>{renderItem({ item })}</React.Fragment>) : ListEmptyComponent}
    </>
  ),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/skeleton', () => ({ Skeleton: host('skeleton') }));
mock.module('@/lib/utils/mono-font', () => ({ MONO_FONT_FAMILY: 'mono' }));
mock.module('@/lib/icons', () => ({ FilePlusIcon: none, FileMinusIcon: none, NotePencilIcon: none }));
import { parsePatchFile } from '@/lib/diff/parse-patch';

mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { foreground: 'fg', mutedForeground: 'muted', border: 'border', destructive: 'red' },
    dark: { foreground: 'fg-dark', mutedForeground: 'muted-dark', border: 'border-dark', destructive: 'red-dark' },
    accent: { green: 'green', purple: 'purple', blue: 'blue' },
  },
  withAlpha: (color: string, alpha: number) => `alpha(${color},${alpha})`,
}));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none, info: none } }));

let ReviewFileDiff: typeof import('@/components/review/ReviewFileDiff').ReviewFileDiff;
let DiffFile: typeof import('@/components/diff/PatchDiffView').DiffFile;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ReviewFileDiff } = await import('@/components/review/ReviewFileDiff'));
  ({ DiffFile } = await import('@/components/diff/PatchDiffView'));
});

const PATCH = [
  'diff --git a/notes.txt b/notes.txt',
  'index 1111111..2222222 100644',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,3 +1,3 @@',
  ' kept',
  '-removed',
  '+added',
].join('\n');

const FILE = { path: 'notes.txt', status: 'modified', additions: 1, deletions: 1 } as never;

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

type Style = Record<string, unknown>;
type RowParts = { container: { style: Style }; gutter: { style: Style; children?: unknown }; content: { style: Style; children?: unknown } };

/** ReviewFileDiff's rendered rows: [{ container, gutter, content }] in patch order. */
const reviewRows = (): RowParts[] => {
  const rows: RowParts[] = [];
  tree!.root.findAllByType('view' as never).forEach((v: { props: { style?: Style }; children?: unknown }) => {
    const kids = (Array.isArray(v.children) ? v.children : []).filter(Boolean) as Array<{ props: { style: Style; children?: unknown } }>;
    const gutterStyle = kids[0]?.props?.style;
    if (kids.length === 2 && typeof gutterStyle?.width === 'number' && gutterStyle.textAlign === 'right') {
      rows.push({
        container: { style: (v.props.style ?? {}) as Style },
        gutter: kids[0].props,
        content: kids[1].props,
      });
    }
  });
  return rows;
};

/** DiffFile's rendered rows, same shape. */
const patchRows = reviewRows;

const rowText = (n: { children?: unknown }) => String(n.children);

describe('diff rows: ReviewFileDiff vs PatchDiffView', () => {
  test('ReviewFileDiff rows: gutter 44 right-aligned, content paddingRight 12, one-line rows, kind colors', () => {
    act(() => {
      tree = create(<ReviewFileDiff patch={PATCH} path="notes.txt" isLoading={false} isError={false} isDark={false} bottomInset={0} />);
    });
    const rows = reviewRows();
    // hunk + kept + removed + added
    expect(rows).toHaveLength(4);
    const [hunk, kept, removed, added] = rows;
    // Gutter: 44pt, right-aligned, mono, muted; empty for hunks.
    expect(hunk.gutter.style).toMatchObject({ width: 44, textAlign: 'right', paddingRight: 8, fontSize: 11, lineHeight: 18 });
    expect(rowText(hunk.gutter as never)).toBe('');
    // Content: mono 12/18, paddingRight 12, no sign prefix on hunk lines.
    expect(hunk.content.style).toMatchObject({ paddingRight: 12, fontSize: 12, lineHeight: 18 });
    expect(hunk.content.style.flex).toBe(1);
    expect(rowText(hunk.content as never)).toBe('@@ -1,3 +1,3 @@');
    expect(hunk.container.style.backgroundColor).toBe('alpha(purple,0.08)');
    // Context row: foreground color, space-prefixed.
    expect(kept.container.style.backgroundColor).toBeUndefined();
    expect(rowText(kept.content as never)).toBe('  kept');
    // Deleted: red on a light-red wash, − prefix.
    expect(removed.container.style.backgroundColor).toBe('alpha(red,0.1)');
    expect(removed.content.style.color).toBe('red');
    expect(rowText(removed.content as never)).toBe('− removed');
    // Added: green on a light-green wash, + prefix.
    expect(added.container.style.backgroundColor).toBe('alpha(green,0.12)');
    expect(added.content.style.color).toBe('green');
    expect(rowText(added.content as never)).toBe('+ added');
    // Rows are one line tall (paddingVertical 1, no minHeight).
    expect(kept.container.style.paddingVertical).toBe(1);
    expect(kept.container.style.minHeight).toBeUndefined();
  });

  test('PatchDiffView DiffFile rows: gutter 42, content paddingRight 14, minHeight 18, unprefixed hunk lines', () => {
    act(() => {
      tree = create(<DiffFile file={FILE} parsed={{ binary: false, rows: [] }} isDark={false} />);
    });
    // DiffFile without parsed rows renders the empty state; drive it with the parser.
    act(() => tree?.unmount());
    act(() => {
      const parsed = parsePatchFile(PATCH, 'notes.txt');
      tree = create(<DiffFile file={FILE} parsed={parsed ? { binary: parsed.binary, rows: parsed.rows } : undefined} isDark={false} />);
    });
    const rows = patchRows();
    expect(rows).toHaveLength(4);
    const [hunk, kept, removed, added] = rows;
    expect(hunk.gutter.style).toMatchObject({ width: 42, textAlign: 'right', paddingRight: 8, fontSize: 11, lineHeight: 18 });
    expect(rowText(hunk.content as never)).toBe('@@ -1,3 +1,3 @@'); // hunks are unprefixed in both copies
    expect(hunk.container.style.backgroundColor).toBe('alpha(purple,0.08)');
    expect(added.content.style.color).toBe('green');
    expect(rowText(added.content as never)).toBe('+ added');
    expect(removed.container.style.backgroundColor).toBe('alpha(red,0.1)');
    // The two deltas this dedupe converges: gutter 42→44, paddingRight 14→12.
    expect(added.gutter.style.width).toBe(42);
    expect(added.content.style.paddingRight).toBe(14);
    expect(kept.container.style.minHeight).toBe(18);
  });

  test('both copies agree on the dark-theme washes and on the empty state', () => {
    act(() => {
      tree = create(<ReviewFileDiff patch={undefined} path="notes.txt" isLoading={false} isError={false} isDark bottomInset={0} />);
    });
    expect(tree!.root.findAllByType('text' as never).map((t: { props: { children?: unknown } }) => String(t.props.children))).toContain('No line changes in this file.');
    act(() => tree?.unmount());
    act(() => {
      tree = create(<ReviewFileDiff patch={PATCH} path="notes.txt" isLoading={false} isError={false} isDark bottomInset={0} />);
    });
    const [hunk, , removed, added] = reviewRows();
    expect(hunk.container.style.backgroundColor).toBe('alpha(purple,0.12)');
    expect(removed.container.style.backgroundColor).toBe('alpha(red-dark,0.14)');
    expect(added.container.style.backgroundColor).toBe('alpha(green,0.14)');
  });
});
