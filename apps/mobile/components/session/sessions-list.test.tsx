import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The Sessions page as one flat list (a row or a group title per item), the
// sub-session tree cap, and the cached starter. Real list logic
// (lib/session/*, the stores, the SDK); every other import is a stub.

const files = ['ProjectSessionsPage.tsx', 'DrawerSessionRows.tsx', 'SessionSubsessionTree.tsx'];
const source = files.map((file) => readFileSync(`${import.meta.dir}/${file}`, 'utf8')).join('\n');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

let list: any;
let paged: any;
const haptic = { count: 0 };
const fakes: Record<string, Record<string, unknown>> = {
  'react-native': {
    View: host('View'),
    Pressable: host('Pressable'),
    RefreshControl: Empty,
    FlatList: (props: any) => {
      list = props;
      const rows = props.data.map((item: any, index: number) =>
        React.createElement(React.Fragment, { key: props.keyExtractor(item, index) }, props.renderItem({ item, index }))
      );
      return React.createElement('List', null, rows);
    },
  },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/kortix/settings-list': {
    SettingsGroup: host('Group'),
    SettingsGroupItem: host('GroupItem'),
    SettingsRow: (props: any) => React.createElement('Row', { label: props.label, value: props.value }),
  },
  '@/components/kortix/page-content': { PageContent: host('Content') },
  '@/components/kortix/pinned-bar': { PinnedBar: Empty, usePinnedBarInset: () => 0 },
  '@/components/session/ProjectRoutes': {
    useProjectRoute: () => route,
    useCoveringRoute: () => openSession,
  },
  '@/lib/projects/hooks': { useProjectSessionsPaged: () => paged },
  '@/lib/review/use-review': { useReviewItems: () => review },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'me' } }) },
  'expo-router/react-navigation': { useIsFocused: () => true },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@/lib/utils/index': { cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') },
  '@/lib/utils/theme': { THEME: { light: { background: 'bg', mutedForeground: 'muted' }, dark: { background: 'bg', mutedForeground: 'muted' } } },
  '@/lib/haptics': { haptics: { tap: () => haptic.count++, selection: () => haptic.count++ } },
  'react-i18next': {
    useTranslation: () => ({
      // i18next's plural defaults: `defaultValue_one` for 1, `defaultValue_other` otherwise (English rules).
      t: (_key: string, options: Record<string, unknown>) =>
        String(options[options.count === 1 ? 'defaultValue_one' : 'defaultValue_other'] ?? options.defaultValue).replace(
          /\{\{(\w+)\}\}/g,
          (_, name) => String(options[name])
        ),
    }),
  },
};
const route = { projectId: 'p-1', openDrawer() {}, newSession() {}, openSessionActions() {}, isDrawerOpen: false };
const openSession = () => {};
const review = { data: [] };
// Real: the list logic under test. Everything else is a stub.
const real = new Set([
  'react',
  '@kortix/sdk',
  '@/lib/session/session-list',
  '@/lib/session/session-tree',
  '@/lib/session/session-pages',
  '@/lib/session/needs-you',
  '@/stores/session-tree-store',
  '@/stores/session-filter-store',
  '@/components/session/DrawerSessionRows',
  '@/components/session/SessionSubsessionTree',
]);
const named = new Map<string, Set<string>>();
for (const [, names, name] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  const set = named.get(name) ?? new Set<string>();
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key) set.add(key);
  }
  named.set(name, set);
}
for (const [name, keys] of named) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const key of keys) if (!(key in values)) values[key] = Empty;
  mock.module(name, () => values);
}

let Page: typeof import('./ProjectSessionsPage');
let Tree: typeof import('./SessionSubsessionTree');
let Rows: typeof import('./DrawerSessionRows');
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Page = await import('./ProjectSessionsPage');
  Tree = await import('./SessionSubsessionTree');
  Rows = await import('./DrawerSessionRows');
});

let tree: any;
beforeEach(() => {
  list = undefined;
  haptic.count = 0;
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});

async function render(element: React.ReactElement) {
  await act(async () => {
    tree = create(element);
  });
}

const HOUR = 60 * 60 * 1000;
function session(id: string, at: number, extra: Record<string, unknown> = {}): any {
  return { session_id: id, name: id, updated_at: new Date(at).toISOString(), created_at: new Date(at).toISOString(), ...extra };
}
function pagedOf(sessions: any[]) {
  return {
    sessions,
    isPending: false,
    isError: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    dataUpdatedAt: 0,
    fetchNextPage: async () => {},
    refetch: async () => {},
  };
}
const textOf = (node: any): string =>
  (node.children ?? []).map((child: any) => (typeof child === 'string' ? child : textOf(child))).join('');

describe('Sessions page list', () => {
  test('one list item per row and per group title, in group order', async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const start = todayStart.getTime();
    paged = pagedOf([
      session('old-2', start - 50 * 24 * HOUR),
      session('today-1', Date.now()),
      session('week-1', start - 3 * 24 * HOUR - HOUR),
      session('old-1', start - 40 * 24 * HOUR),
      session('yesterday-1', start - 12 * HOUR),
    ]);
    await render(React.createElement(Page.ProjectSessionsPage));
    expect(list.data.map((item: any) => item.key)).toEqual([
      'title:today',
      'today-1',
      'title:yesterday',
      'yesterday-1',
      'title:week',
      'week-1',
      'title:older',
      'old-1',
      'old-2',
    ]);
    // The group gap sits above each group after the first; corners follow the group.
    expect(list.data.filter((item: any) => item.first).map((item: any) => item.key)).toEqual([
      'title:yesterday',
      'title:week',
      'title:older',
    ]);
    const older = list.data.filter((item: any) => item.kind === 'row' && item.key.startsWith('old'));
    expect(older.map((item: any) => [item.index, item.count])).toEqual([[0, 2], [1, 2]]);
    // Rendered: the titles (`SettingsGroup`'s title style) and the rows, in the same order.
    const rendered = tree.root
      .findAll((node: any) => node.type === 'Row' || (node.type === 'Text' && node.props.className === 'mb-2 px-4'))
      .map((node: any) => (node.type === 'Row' ? node.props.label : textOf(node)));
    expect(rendered).toEqual(['Today', 'today-1', 'Yesterday', 'yesterday-1', 'This week', 'week-1', 'Older', 'old-1', 'old-2']);
    // Each row is a SettingsGroupItem that knows its place in the group.
    const items = tree.root.findAll((node: any) => node.type === 'GroupItem');
    expect(items.map((node: any) => [node.props.index, node.props.count])).toEqual([[0, 1], [0, 1], [0, 1], [0, 2], [1, 2]]);
  });

  test('one group shows no title', async () => {
    paged = pagedOf([session('a', Date.now()), session('b', Date.now() - 1000)]);
    await render(React.createElement(Page.ProjectSessionsPage));
    expect(list.data.map((item: any) => item.key)).toEqual(['a', 'b']);
    expect(list.data.some((item: any) => item.first)).toBe(false);
  });

  test('sessionListItems keeps titles out when showHeaders is false', () => {
    const rows = [session('x', 0), session('y', 0)];
    const items = Page.sessionListItems(
      [
        { id: 'today', label: 'Today', sessions: [rows[0]] },
        { id: 'older', label: 'Older', sessions: [rows[1]] },
      ],
      false
    );
    expect(items.map((item) => [item.key, item.first])).toEqual([['x', false], ['y', true]]);
  });
});

describe('SubsessionTree', () => {
  const subsessions = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `child-${index}`, title: `Child ${index}`, updated_at: Date.now() - index * 60_000 })) as any[];
  const rowsOf = () =>
    tree.root.findAll((node: any) => node.type === 'Pressable' && String(node.props.accessibilityLabel).includes(', sub-session of'));
  const moreOf = () =>
    tree.root.findAll((node: any) => node.type === 'Pressable' && String(node.props.accessibilityLabel).startsWith('Show '));

  test('shows the first 5 rows and a "Show N more" row that expands in place', async () => {
    const opened: string[] = [];
    await render(
      React.createElement(Tree.SubsessionTree, {
        parentId: 'parent-1',
        subsessions: subsessions(8),
        parentTitle: 'Parent',
        activeRuntimeId: null,
        trunkX: 26,
        textX: 48,
        onPressSubsession: (id: string) => opened.push(id),
      })
    );
    expect(rowsOf()).toHaveLength(5);
    expect(moreOf()).toHaveLength(1);
    expect(moreOf()[0].props.accessibilityLabel).toBe('Show 3 more sub-sessions of Parent');
    expect(textOf(moreOf()[0])).toBe('Show 3 more');
    await act(async () => moreOf()[0].props.onPress());
    expect(rowsOf()).toHaveLength(8);
    expect(moreOf()).toHaveLength(0);
    expect(haptic.count).toBe(1);
    await act(async () => rowsOf()[7].props.onPress());
    expect(opened).toEqual(['child-7']);
  });

  test('one hidden row reads in the singular', async () => {
    await render(
      React.createElement(Tree.SubsessionTree, {
        parentId: 'parent-1',
        subsessions: subsessions(6),
        parentTitle: 'Parent',
        activeRuntimeId: null,
        trunkX: 26,
        textX: 48,
        onPressSubsession: () => {},
      })
    );
    expect(moreOf()[0].props.accessibilityLabel).toBe('Show 1 more sub-session of Parent');
    expect(textOf(moreOf()[0])).toBe('Show 1 more');
  });

  test('the open sub-session is never hidden by the cap', async () => {
    await render(
      React.createElement(Tree.SubsessionTree, {
        parentId: 'parent-1',
        subsessions: subsessions(8),
        parentTitle: 'Parent',
        activeRuntimeId: 'child-6',
        trunkX: 26,
        textX: 48,
        onPressSubsession: () => {},
      })
    );
    expect(rowsOf()).toHaveLength(8);
    expect(moreOf()).toHaveLength(0);
    const selected = rowsOf().filter((node: any) => node.props.accessibilityState?.selected);
    expect(selected.map((node: any) => node.props.accessibilityLabel)).toEqual(['Child 6, sub-session of Parent']);
  });

  test('an active row inside the cap keeps the cap', async () => {
    await render(
      React.createElement(Tree.SubsessionTree, {
        parentId: 'parent-1',
        subsessions: subsessions(8),
        parentTitle: 'Parent',
        activeRuntimeId: 'child-4',
        trunkX: 26,
        textX: 48,
        onPressSubsession: () => {},
      })
    );
    expect(rowsOf()).toHaveLength(5);
    expect(moreOf()).toHaveLength(1);
    expect(rowsOf().filter((node: any) => node.props.accessibilityState?.selected)).toHaveLength(1);
  });

  test('SubsessionTreeMemory keeps an expanded tree expanded across a remount', async () => {
    const treeOf = (parentId: string) =>
      React.createElement(Tree.SubsessionTree, {
        key: parentId,
        parentId,
        subsessions: subsessions(8),
        parentTitle: 'Parent',
        activeRuntimeId: null,
        trunkX: 26,
        textX: 48,
        onPressSubsession: () => {},
      });
    const list = (children: React.ReactNode) => React.createElement(Tree.SubsessionTreeMemory, null, children);
    await render(list([treeOf('a'), treeOf('b')]));
    expect(rowsOf()).toHaveLength(10);
    // Expand tree `a` (its "Show more" row is the first one).
    await act(async () => moreOf()[0].props.onPress());
    expect(rowsOf()).toHaveLength(13);
    // Virtualisation unmounts both rows, then mounts them again.
    await act(async () => tree.update(list([])));
    expect(rowsOf()).toHaveLength(0);
    await act(async () => tree.update(list([treeOf('a'), treeOf('b')])));
    expect(rowsOf()).toHaveLength(13);
    expect(moreOf()).toHaveLength(1);
  });

  test('5 or fewer rows show no "Show more" row', async () => {
    await render(
      React.createElement(Tree.SubsessionTree, {
        parentId: 'parent-1',
        subsessions: subsessions(5),
        parentTitle: 'Parent',
        activeRuntimeId: null,
        trunkX: 26,
        textX: 48,
        onPressSubsession: () => {},
      })
    );
    expect(rowsOf()).toHaveLength(5);
    expect(moreOf()).toHaveLength(0);
  });

  test('the relative time shows only with the list clock', async () => {
    const props = { parentId: 'parent-1', subsessions: subsessions(1), parentTitle: 'Parent', activeRuntimeId: null, trunkX: 26, textX: 48, onPressSubsession: () => {} };
    await render(React.createElement(Tree.SubsessionTree, props));
    expect(rowsOf()[0].props.accessibilityLabel).toBe('Child 0, sub-session of Parent');
    await act(async () => tree.update(React.createElement(Tree.SubsessionTree, { ...props, now: Date.now() })));
    expect(rowsOf()[0].props.accessibilityLabel).toMatch(/^Child 0, sub-session of Parent, /);
  });
});

describe('useSessionStarterOf', () => {
  test('returns the same starter object for the same session row', async () => {
    let starterOf!: (session: any) => unknown;
    function Probe({ viewerId }: { viewerId: string | null }) {
      starterOf = Rows.useSessionStarterOf(viewerId);
      return null;
    }
    const row = session('s', 0, { initiator: { type: 'member', id: 'me', label: 'Jay' } });
    await render(React.createElement(Probe, { viewerId: 'me' }));
    const first = starterOf(row);
    expect(first).toEqual({ type: 'member', label: 'You', icon: null });
    expect(starterOf(row)).toBe(first);
    // A changed row (a new object) gets a fresh starter.
    expect(starterOf({ ...row })).not.toBe(first);
    // Another viewer re-derives the label.
    await act(async () => tree.update(React.createElement(Probe, { viewerId: 'other' })));
    expect(starterOf(row)).toEqual({ type: 'member', label: 'Jay', icon: null });
  });
});
