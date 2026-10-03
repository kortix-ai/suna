import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The project drawer re-renders on every open, close and poll. Its session
// rows, the children blocks and Previous chats must not re-render with it
// unless their own inputs changed. Real: the drawer, its rows, the list logic
// and the stores. Every other import is a stub.

const files = ['ProjectLeftDrawer.tsx', 'use-project-drawer-sessions.ts', 'DrawerBottomBar.tsx', 'DrawerSessionRows.tsx'];
const source = files.map((file) => readFileSync(`${import.meta.dir}/${file}`, 'utf8')).join('\n');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

const renders = { mark: 0, children: 0, legacy: 0 };
let childrenProps: any[] = [];
let paged: Record<string, any> = {};
const VirtualList = (props: any) => {
  // A virtualised list renders each cell as a PureComponent: a cell re-renders
  // only when its item or `renderItem` changes.
  return React.createElement(
    'List',
    null,
    props.ListHeaderComponent,
    props.data.map((item: any) =>
      React.createElement(Cell, { key: props.keyExtractor(item), item, renderItem: props.renderItem })
    ),
    props.ListFooterComponent
  );
};
const Cell = React.memo(({ item, renderItem }: any) => renderItem({ item }));
const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), Pressable: host('Pressable'), RefreshControl: Empty, StyleSheet: { absoluteFill: {} } },
  'react-native-reanimated': {
    default: { FlatList: VirtualList, View: host('View') },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 0,
    useAnimatedReaction: () => {},
    useAnimatedScrollHandler: () => () => {},
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
  },
  'react-native-drawer-layout': { useDrawerProgress: () => ({ value: 1 }) },
  'expo-router': { useIsFocused: () => true },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/session/SessionStatusMark': { SessionStatusMark: () => { renders.mark++; return null; } },
  '@/components/session/SessionTreeParts': {
    SessionChildren: (props: any) => { renders.children++; childrenProps.push(props); return null; },
  },
  '@/components/menu/LegacyChatsSection': { LegacyChatsSection: () => { renders.legacy++; return null; } },
  '@/lib/projects/hooks': {
    useProject: () => ({ data: { name: 'Project', account_id: 'a-1' } }),
    useAccounts: () => ({ data: [] }),
    useProjectSessionsPaged: (_: string, options: { startedBy: string }) => paged[options.startedBy],
  },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'me' } }) },
  '@/hooks/useProfileEditor': { useProfileEditor: () => profile },
  '@/hooks/useActivePlanName': { useActivePlanName: () => null },
  '@/lib/utils/index': { cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') },
  '@/lib/utils/theme': {
    THEME: { light: { mutedForeground: 'm', foreground: 'f', chromeBackground: 'c' }, dark: { mutedForeground: 'm', foreground: 'f', chromeBackground: 'c' } },
    withAlpha: (color: string) => color,
  },
  '@/lib/ui/font-scale': { BUTTON_LABEL_MAX_FONT_SCALE: { sm: 1, lg: 1 } },
  '@/lib/haptics': { haptics: { tap() {}, selection() {} } },
};
const profile = { avatarUrl: null, displayName: 'Me' };
const real = new Set([
  'react',
  '@kortix/sdk',
  './DrawerSessionRows',
  './use-project-drawer-sessions',
  './DrawerBottomBar',
  // Real: the open refetch is characterized below (it must not be a stub).
  '@/components/session/use-refetch-on-open',
  '@/lib/session/session-list',
  '@/lib/session/session-tree',
  '@/lib/session/session-pages',
  '@/lib/session/project-stack',
  '@/stores/session-tree-store',
  '@/components/session/SessionSubsessionTree',
]);
const named = new Map<string, Set<string>>();
for (const [, names, name] of source.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
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
// SessionSubsessionTree (real) imports these; the drawer does not.
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_: string, o: any) => o.defaultValue_other }) }));

let Drawer: typeof import('./ProjectLeftDrawer');
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Drawer = await import('./ProjectLeftDrawer');
});

const page = (sessions: any[]) => ({
  sessions,
  isPending: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: async () => {},
  refetch: async () => {},
});
const at = new Date().toISOString();
const row = (id: string, extra: Record<string, unknown> = {}) => ({ session_id: id, name: id, updated_at: at, ...extra });

let tree: any;
beforeEach(() => {
  renders.mark = renders.children = renders.legacy = 0;
  childrenProps = [];
  // `p-1` is expanded below: its children block shows.
  paged = {
    me: page([row('s-1'), row('s-2'), row('p-1', { child_count: 2 })]),
    others: page([row('o-1', { initiator: { type: 'member', id: 'u-2', label: 'Ana' } })]),
    automated: page([]),
  };
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});

const handlers = {
  onNewSession() {},
  onOpenProjectSession() {},
  onOpenSubsession() {},
  onNavigateRoute() {},
  onSessionActions() {},
  onOpenSwitcher() {},
  onClose() {},
};

describe('ProjectLeftDrawer renders', () => {
  test('opening and closing re-renders no session row and no Previous chats', async () => {
    const { useSessionTreeStore, parentKey, sectionKey } = await import('@/stores/session-tree-store');
    useSessionTreeStore.getState().setChoice(parentKey('proj', 'p-1'), true);
    useSessionTreeStore.getState().setChoice(sectionKey('proj', 'shared'), true);
    const props = { projectId: 'proj', ...handlers, open: false };
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, props));
    });
    // 3 own rows + 1 shared row, one status mark each.
    expect(renders.mark).toBe(4);
    expect(renders.children).toBe(1);
    expect(childrenProps.at(-1).showLoader).toBe(false);
    const before = { ...renders };
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: true })));
    expect(renders.mark).toBe(before.mark);
    expect(renders.legacy).toBe(before.legacy);
    // The children block's loader follows `open`.
    expect(childrenProps.at(-1).showLoader).toBe(true);
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: false })));
    expect(renders.mark).toBe(before.mark);
    expect(renders.legacy).toBe(before.legacy);
    expect(childrenProps.at(-1).showLoader).toBe(false);
  });

  test('a new session on screen re-renders only the rows it touches', async () => {
    const props = { projectId: 'proj', ...handlers, open: true, activeProjectSessionId: null as string | null };
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, props));
    });
    const before = renders.mark;
    await act(async () =>
      tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, activeProjectSessionId: 's-2', activeRuntimeSessionId: 'rt-2' }))
    );
    // Only the newly highlighted row.
    expect(renders.mark - before).toBe(1);
    const rowLabels = tree.root
      .findAll((node: any) => node.type === 'Pressable' && node.props.accessibilityState?.selected === true)
      .map((node: any) => node.props.accessibilityLabel);
    expect(rowLabels).toHaveLength(1);
    expect(rowLabels[0]).toStartWith('s-2, ');
  });

  test('the open sub-session stays highlighted when it is past the 5-row cap', async () => {
    // Root `rt-root` with 8 sub-sessions, newest first: child-0 … child-7.
    const runtime = [
      { id: 'rt-root', parent_id: null, updated_at: 100 },
      ...Array.from({ length: 8 }, (_, index) => ({ id: `child-${index}`, parent_id: 'rt-root', title: `Child ${index}`, updated_at: 90 - index })),
    ];
    paged.me = page([row('s-9', { opencode_session_id: 'rt-root', runtime_session_id: 'rt-root', runtime_sessions: runtime })]);
    await act(async () => {
      tree = create(
        React.createElement(Drawer.ProjectLeftDrawer, {
          projectId: 'proj',
          ...handlers,
          open: true,
          activeProjectSessionId: 's-9',
          activeRuntimeSessionId: 'child-6',
        })
      );
    });
    const selected = tree.root
      .findAll((node: any) => node.type === 'Pressable' && node.props.accessibilityState?.selected === true)
      .map((node: any) => node.props.accessibilityLabel);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toStartWith('Child 6, sub-session of ');
  });

  test('opening refetches the sessions once the slide ends; a close first cancels it', async () => {
    const refetched: string[] = [];
    for (const section of ['me', 'others', 'automated'] as const) {
      paged[section].refetch = async () => {
        refetched.push(section);
      };
    }
    const props = { projectId: 'proj', ...handlers, open: false };
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, props));
    });
    // Closed: no refetch.
    expect(refetched).toEqual([]);
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: true })));
    // The refetch waits out the drawer's 420ms slide (DRAWER_REFETCH_DELAY_MS).
    expect(refetched).toEqual([]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    // Mine and Shared always; the collapsed Automated section is skipped.
    expect(refetched).toEqual(['me', 'others']);
    // A re-render while open (a poll, a sheet) does not re-arm it.
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: true })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(refetched).toEqual(['me', 'others']);
    // A close before the slide ends cancels the pending refetch.
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: false })));
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: true })));
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: false })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(refetched).toEqual(['me', 'others']);
  });
});
