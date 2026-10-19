import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The project switcher sheet (KRTX-2461's characterization test): the
// projects body's five states (in flight, error, empty, no matches, the
// group), the invites group first, the account tab, and the hand-off
// choreography (a `+` tap dismisses and only then opens the web hand-off;
// "Not now" re-presents instead of dismissing into the void).
// Real: the sheet body, `useSheetOpenMove` + `useCloseThen` (the
// choreography under test) and the switcher helpers. Every import that
// needs a native runtime is a stub.

const source = readFileSync(`${import.meta.dir}/ProjectSwitcherSheet.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

// The choreography's observable: every present/dismiss the sheet module sees.
const sheetCalls: string[] = [];
let projectsData: unknown[] | undefined;
let projectsFail = false;
let invitesData: unknown[] | undefined = [];
const pushCalls: string[] = [];
let webCreateUrl: string | null = null;
let searchInput: ((text: string) => void) | null = null;
let tabSelect: ((index: number) => void) | null = null;

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': {
    View: host('View'),
    StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  },
  // The base component drives gorhom's modal directly; the head drives it
  // through `KortixBottomSheetModal`. Both get the same imperative handle:
  // present/dismiss recorded, onDismiss fired on dismiss.
  '@gorhom/bottom-sheet': {
    BottomSheetModal: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        present: () => {
          sheetCalls.push('present');
        },
        dismiss: () => {
          sheetCalls.push('dismiss');
          props.onDismiss?.();
        },
      }));
      return React.createElement('BottomSheetModal', null, props.children);
    }),
    BottomSheetScrollView: host('Scroll'),
  },
  'expo-router': { useRouter: () => ({ push: (href: string) => pushCalls.push(href), replace: () => {} }) },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  'react-native-reanimated': { useDerivedValue: (v: unknown) => v },
  '@/lib/icons': { FolderIcon: host('FolderIcon'), PlusIcon: host('PlusIcon'), UserIcon: host('UserIcon') },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/ui/icon': { Icon: host('Icon') },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/kortix/avatar': { Avatar: host('Avatar') },
  '@/components/kortix/sheet': {
    // Present/dismiss recorded; onDismiss fires synchronously (the close
    // animation stands in as an immediate one).
    KortixBottomSheetModal: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        present: () => {
          sheetCalls.push('present');
        },
        dismiss: () => {
          sheetCalls.push('dismiss');
          props.onDismiss?.();
        },
      }));
      return React.createElement('SwitcherSheet', null, props.titleTrailing, props.children);
    }),
    useSheetBackground: () => 'sheet',
    // Real: the present/dismiss glue and the close-then slot ARE the
    // choreography this suite pins. Both hooks are React-only modules
    // (`use-sheet-open-move.ts`, `use-close-then.ts`), so they load without
    // the sheet module's native graph.
    useSheetOpenMove: require('@/components/kortix/use-sheet-open-move').useSheetOpenMove,
    useCloseThen: require('@/components/kortix/use-close-then').useCloseThen,
  },
  '@/components/kortix/pinned-bar': { PinnedBar: host('PinnedBar'), usePinnedBarInset: () => 0 },
  '@/components/navigation/FloatingTabBar': {
    FloatingTabCapsule: (props: any) => {
      tabSelect = props.onSelect;
      return React.createElement('FloatingTabCapsule', null);
    },
  },
  '@/components/navigation/tab-bar-layout': { FLOATING_BAR_HEIGHT: 49 },
  '@/components/kortix/kortix-loader': { KortixLoader: host('KortixLoader') },
  '@/components/kortix/settings-list': { SettingsGroup: host('Group'), SettingsRow: host('Row') },
  '@/components/kortix/SheetInput': {
    SheetTextInput: (props: any) => {
      searchInput = props.onChangeText;
      return React.createElement('SheetTextInput', null);
    },
  },
  '@/components/projects/useWebCreateHandoff': {
    useWebCreateHandoff: () => ({ pending: false, open: (url: string) => (webCreateUrl = url) }),
  },
  '@/components/session/WebHandoffSheet': {
    WebHandoffSheet: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ open: () => props.run?.() }));
      return null;
    }),
  },
  'react-i18next': { useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) },
  '@/contexts': { useLanguage: () => ({ t: (key: string) => key }) },
  '@/lib/haptics': { haptics: { tap() {}, selection() {}, medium() {}, warning() {} } },
  '@/lib/projects/hooks': {
    // Reads the mutable module state, so a test can fail the query.
    useProjects: (accountId: string | null) =>
      accountId === null || projectsFail
        ? { data: undefined, isPending: accountId === null && !projectsFail, isError: projectsFail, refetch() {} }
        : { data: projectsData, isPending: false, isError: false, refetch() {} },
  },
  '@/lib/invites/hooks': { useMyInvites: () => ({ data: invitesData }) },
  '@/lib/kortix-web': { KORTIX_WEB_URL: 'https://kortix.test' },
  // One stable instance: a fresh object per call loops useSyncExternalStore forever.
  '@/stores/current-account-store': {
    useCurrentAccountStore: (() => {
      const store = { setSelectedAccountId() {} };
      return () => store;
    })(),
  },
};
const real = new Set([
  'react',
  '@/lib/ui/sheet-open',
  '@/lib/projects/switcher',
  '@/lib/invites/invite-landing',
  '@/lib/projects/web-project-links',
]);
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(
  /import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs,
)) {
  if (real.has(name)) continue;
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let ProjectSwitcherSheet: typeof import('./ProjectSwitcherSheet').ProjectSwitcherSheet;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The present glue defers one frame; the browser runtime owns rAF, this
  // harness stands in for it.
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) =>
    setTimeout(fn, 0) as unknown as number;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (t: unknown) =>
    clearTimeout(t as number);
  ProjectSwitcherSheet = (await import('./ProjectSwitcherSheet')).ProjectSwitcherSheet;
});

const ACCOUNT = { account_id: 'acc-1', name: 'Acme' };
const OTHER = { account_id: 'acc-2', name: 'Globex' };
const PROJECT = (id: string, name: string, account_id = 'acc-1') => ({ project_id: id, account_id, name });

let tree: any;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  sheetCalls.length = 0;
  pushCalls.length = 0;
  projectsData = undefined;
  projectsFail = false;
  invitesData = [];
  webCreateUrl = null;
  searchInput = null;
  tabSelect = null;
});

const rows = () => tree.root.findAll((n: any) => n.type === 'Row').map((n: any) => n.props);
const texts = () => tree.root.findAll((n: any) => n.type === 'Text').map((n: any) => n.props.children);

/** Mount closed, then flip `open`; flushes the deferred present frame. */
async function openAs(props: Record<string, unknown> = {}) {
  await act(async () => {
    tree = create(React.createElement(ProjectSwitcherSheet, { onClose: () => {}, open: false, ...props } as never));
    tree.update(React.createElement(ProjectSwitcherSheet, { onClose: () => {}, open: true, ...props } as never));
  });
  // The present glue defers one frame; the harness stands in for the browser's rAF.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('ProjectSwitcherSheet', () => {
  test('closed: never presented', async () => {
    await act(async () => {
      tree = create(React.createElement(ProjectSwitcherSheet, { open: false, accounts: [ACCOUNT] } as never));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(sheetCalls).toEqual([]);
  });

  test('open presents; the picked account projects render as rows, the open one without a press', async () => {
    projectsData = [PROJECT('p-1', 'Website'), PROJECT('p-2', 'API')];
    await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1', currentProjectId: 'p-1' });
    expect(sheetCalls).toContain('present');
    const projectRows = rows();
    expect(projectRows.map((r: any) => r.label)).toEqual(['Website', 'API']);
    // Every row presses; tapping the open project closes instead of re-navigating
    // (the same rule as the open session's row in the drawer).
    expect(typeof projectRows[0].onPress).toBe('function');
    expect(typeof projectRows[1].onPress).toBe('function');
  });

  test('no account chip yet: in flight (loader), never the empty state', async () => {
    await openAs({ accounts: [ACCOUNT], selectedAccountId: null });
    expect(tree.root.findAll((n: any) => n.type === 'KortixLoader')).toHaveLength(1);
    expect(rows()).toEqual([]);
  });

  test('the account has no projects: the empty state with its create CTA', async () => {
    projectsData = [];
    await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1' });
    expect(texts()).toContain('No projects yet');
  });

  test('a failed projects read: the error line with a retry', async () => {
    projectsFail = true;
    try {
      await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1' });
      expect(texts()).toContain("Couldn't load projects");
    } finally {
      projectsFail = false;
    }
  });

  test('a query that matches nothing: the no-matches line', async () => {
    projectsData = Array.from({ length: 7 }, (_, i) => PROJECT(`p-${i}`, `Project ${i}`));
    await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1' });
    act(() => searchInput!('zzz'));
    expect(rows()).toEqual([]);
    expect(texts().some((t: unknown) => String(t).includes('No matches for'))).toBe(true);
  });

  test('the account tab lists the other accounts plus New account', async () => {
    projectsData = [PROJECT('p-1', 'Website')];
    await openAs({ accounts: [ACCOUNT, OTHER], selectedAccountId: 'acc-1' });
    expect(typeof tabSelect).toBe('function');
    act(() => tabSelect!(0));
    const accountRows = rows().map((r: any) => r.label);
    expect(accountRows).toContain('Acme');
    expect(accountRows).toContain('Globex');
    expect(accountRows[accountRows.length - 1]).toBe('New account');
  });

  test('the invites group renders first (KRTX-1731)', async () => {
    invitesData = [{ invite_id: 'inv-1', account_name: 'Globex', projects: [] }];
    projectsData = [PROJECT('p-1', 'Website')];
    await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1' });
    const groups = tree.root.findAll((n: any) => n.type === 'Group').map((n: any) => n.props);
    expect(groups[0].title).toBe('invites.group');
  });

  test('a `+` tap dismisses the sheet first, then opens the web hand-off', async () => {
    projectsData = [PROJECT('p-1', 'Website')];
    await openAs({ accounts: [ACCOUNT], selectedAccountId: 'acc-1' });
    const add = tree.root.findAll(
      (n: any) => n.type === 'Button' && n.props.accessibilityLabel === 'New project',
    );
    expect(add).toHaveLength(1);
    act(() => add[0].props.onPress());
    expect(sheetCalls).toContain('dismiss');
    expect(webCreateUrl).toContain('kortix.test');
  });
});
