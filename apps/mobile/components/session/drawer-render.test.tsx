import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The project drawer re-renders on every open, close and poll. Its session
// rows, the children blocks and Previous chats must not re-render with it
// unless their own inputs changed. Real: the drawer, its rows, the list logic
// and the stores. Every other import is a stub.

const files = ['ProjectLeftDrawer.tsx', 'DrawerSessionRows.tsx'];
const source = files.map((file) => readFileSync(`${import.meta.dir}/${file}`, 'utf8')).join('\n');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

const renders = { mark: 0, children: 0 };
let childrenProps: any[] = [];
let navPills: any[] = [];
// The IAM leaves the caller holds; null = every leaf (a project manager).
let held: string[] | null = null;
let appCount = 0;
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
  '@/components/ui/button': { Button: host('Button') },
  '@/components/kortix/kortix-loader': { KortixLoader: host('Loader') },
  './DrawerNavRows': { NavPill: (props: any) => { navPills.push(props); return null; } },
  '@/components/session/SessionStatusMark': { SessionStatusMark: () => { renders.mark++; return null; } },
  '@/components/session/SessionTreeParts': {
    SessionChildren: (props: any) => { renders.children++; childrenProps.push(props); return null; },
  },
  '@/lib/projects/hooks': {
    useProject: () => ({ data: { name: 'Project', account_id: 'a-1' } }),
    useAccounts: () => ({ data: [] }),
    // The Pinned query is keyed by its view, the three sections by their
    // starter. A test that sets no Pinned page gets an empty one.
    useProjectSessionsPaged: (_: string, options: { startedBy?: string; view?: string }) =>
      paged[options.view ?? options.startedBy ?? ''] ?? page([]),
  },
  '@kortix/sdk/react': {
    useCans: (_: unknown, actions: string[]) =>
      Object.fromEntries(actions.map((a) => [a, { allowed: held === null || held.includes(a), isLoading: false }])),
    useProjectApps: () => ({ data: Array.from({ length: appCount }) }),
  },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'me' } }) },
  '@/hooks/useProfileEditor': { useProfileEditor: () => profile },
  '@/hooks/useActivePlanName': { useActivePlanName: () => null },
  '@/components/session/use-refetch-on-open': { useRefetchOnOpen: () => {} },
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
  '@/lib/session/session-list',
  '@/lib/session/session-tree',
  '@/lib/session/session-pages',
  '@/lib/session/project-stack',
  '@/lib/session/nav-access',
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
// The drawer's Pinned title and SessionSubsessionTree (real): the key, or the plural default.
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: any) => o?.defaultValue_other ?? key }) }));

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
  renders.mark = renders.children = 0;
  childrenProps = [];
  navPills = [];
  held = null;
  appCount = 0;
  // `p-1` is expanded below: its children block shows.
  paged = {
    me: page([row('s-1'), row('s-2'), row('p-1', { child_count: 2 })]),
    others: page([row('o-1', { initiator: { type: 'member', id: 'u-2', label: 'Ana' } })]),
    automated: page([]),
    pinned: page([]),
  };
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});

const navigated: unknown[][] = [];
const handlers = {
  onNewSession() {},
  onOpenProjectSession() {},
  onOpenSubsession() {},
  onNavigateRoute(...args: unknown[]) {
    navigated.push(args);
  },
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
    // The children block's loader follows `open`.
    expect(childrenProps.at(-1).showLoader).toBe(true);
    await act(async () => tree.update(React.createElement(Drawer.ProjectLeftDrawer, { ...props, open: false })));
    expect(renders.mark).toBe(before.mark);
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

  test('the nav pills are Search, Files, Review and Apps: Notifications is the home bell', async () => {
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    expect([...new Set(navPills.map((props) => props.label))]).toEqual(['Search', 'Files', 'Review', 'Apps']);
  });

  test('a plain member sees neither Review nor Apps; an existing App brings Apps back', async () => {
    held = ['project.review.read'];
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    expect([...new Set(navPills.map((props) => props.label))]).toEqual(['Search', 'Files']);
    appCount = 1;
    navPills = [];
    await act(async () => {
      tree.unmount();
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    expect([...new Set(navPills.map((props) => props.label))]).toEqual(['Search', 'Files', 'Apps']);
  });

});

// KRTX-1727: the server drops rows the viewer may not see after a bounded
// scan, so a page can come back empty with a cursor. That is not an empty list.
describe('ProjectLeftDrawer past page one', () => {
  const textOf = (node: any): string =>
    (node.children ?? []).map((child: any) => (typeof child === 'string' ? child : textOf(child))).join('');
  const emptyFlower = () =>
    tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityLabel === 'No sessions yet');
  const header = (title: string) =>
    tree.root.findAll((node: any) => node.type === 'Pressable' && String(node.props.accessibilityLabel).startsWith(`${title}, `));
  const buttons = (label: string) => tree.root.findAll((node: any) => node.type === 'Button' && textOf(node) === label);
  const mount = async () => {
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
  };

  test('Shared stays while it has a next page, even with no row yet', async () => {
    paged.others = { ...page([]), hasNextPage: true };
    await mount();
    expect(header('Shared')).toHaveLength(1);
  });

  test('Shared with no row and no next page has no header', async () => {
    paged.others = page([]);
    await mount();
    expect(header('Shared')).toHaveLength(0);
  });

  test('no row anywhere but a next page: Show more, never "No sessions yet"', async () => {
    let fetched = 0;
    paged = {
      me: { ...page([]), hasNextPage: true, fetchNextPage: async () => void fetched++ },
      others: page([]),
      automated: page([]),
    };
    await mount();
    expect(emptyFlower()).toHaveLength(0);
    expect(buttons('Show more')).toHaveLength(1);
    await act(async () => buttons('Show more')[0].props.onPress());
    expect(fetched).toBe(1);
  });

  // The render between two scan pages: no page fetch runs, the scan is not over.
  test('while the list reads past empty pages on its own: a loader, no button', async () => {
    paged = {
      me: { ...page([]), hasNextPage: true, isScanning: true, isFetchingNextPage: false },
      others: page([]),
      automated: page([]),
    };
    await mount();
    expect(emptyFlower()).toHaveLength(0);
    expect(buttons('Show more')).toHaveLength(0);
    expect(tree.root.findAll((node: any) => node.type === 'Loader').length).toBeGreaterThan(0);
  });

  test('Shared between two scan pages: its row reads Loading…, not Show more', async () => {
    const { useSessionTreeStore, sectionKey } = await import('@/stores/session-tree-store');
    useSessionTreeStore.getState().setChoice(sectionKey('proj', 'shared'), true);
    paged.others = { ...page([]), hasNextPage: true, isScanning: true, isFetchingNextPage: false };
    await mount();
    expect(buttons('Show more')).toHaveLength(0);
    expect(buttons('Loading…')).toHaveLength(1);
    expect(buttons('Loading…')[0].props.disabled).toBe(true);
  });

  // COR-146: a failed own list is an error with a retry, also while Shared
  // has a next page. Shared and Automated never decide that verdict.
  test('the own list failed and Shared has a next page: the error and Try again', async () => {
    paged = {
      me: { ...page([]), isError: true },
      others: { ...page([]), hasNextPage: true },
      automated: page([]),
    };
    await mount();
    const texts = tree.root.findAll((node: any) => node.type === 'Text').map(textOf);
    expect(texts).toContain("Couldn't load sessions");
    expect(buttons('Try again')).toHaveLength(1);
    expect(emptyFlower()).toHaveLength(0);
  });

  test('no own row and no own next page, but Shared has one: no empty flower, no error', async () => {
    paged = {
      me: page([]),
      others: { ...page([]), hasNextPage: true },
      automated: page([]),
    };
    await mount();
    expect(emptyFlower()).toHaveLength(0);
    expect(header('Shared')).toHaveLength(1);
    expect(buttons('Try again')).toHaveLength(0);
  });

  test('no row and no next page anywhere: the empty flower as before', async () => {
    paged = { me: page([]), others: page([]), automated: page([]) };
    await mount();
    expect(emptyFlower()).toHaveLength(1);
  });

  // KRTX-2418: the viewer's pinned sessions, above the three sections.
  test('a pinned session shows once, under Pinned at the top, not again under Sessions', async () => {
    paged.pinned = page([row('s-2', { pinned_at: at, archived_at: null })]);
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    const labels: string[] = tree.root
      .findAll((node: any) => node.type === 'Pressable' && typeof node.props.accessibilityLabel === 'string')
      .map((node: any) => node.props.accessibilityLabel);
    const pinnedHeader = labels.indexOf('sessions.pinnedSection, collapse');
    const sessionsHeader = labels.indexOf('Sessions, collapse');
    expect(pinnedHeader).toBeGreaterThanOrEqual(0);
    expect(sessionsHeader).toBeGreaterThan(pinnedHeader);
    const s2 = labels.filter((label) => label.startsWith('s-2, '));
    expect(s2).toHaveLength(1);
    expect(labels.indexOf(s2[0])).toBe(pinnedHeader + 1);
    expect(labels.some((label) => label.startsWith('s-1, '))).toBe(true);
  });

  test('no pinned session: no Pinned header', async () => {
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    const labels = tree.root
      .findAll((node: any) => node.type === 'Pressable' && typeof node.props.accessibilityLabel === 'string')
      .map((node: any) => node.props.accessibilityLabel);
    expect(labels.some((label: string) => label.startsWith('sessions.pinnedSection'))).toBe(false);
  });

  // A server without the feature ignores `pinned=only` and answers the whole list.
  test('rows without a pin stamp never fill Pinned', async () => {
    paged.pinned = page([row('s-1'), row('s-2')]);
    await act(async () => {
      tree = create(React.createElement(Drawer.ProjectLeftDrawer, { projectId: 'proj', ...handlers, open: true }));
    });
    const labels = tree.root
      .findAll((node: any) => node.type === 'Pressable' && typeof node.props.accessibilityLabel === 'string')
      .map((node: any) => node.props.accessibilityLabel);
    expect(labels.some((label: string) => label.startsWith('sessions.pinnedSection'))).toBe(false);
    expect(labels.filter((label: string) => label.startsWith('s-1, '))).toHaveLength(1);
  });
});
