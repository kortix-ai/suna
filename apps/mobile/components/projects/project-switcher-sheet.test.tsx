import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The workspace switcher sheet (KRTX-2461's characterization test, reworked
// for Workspaces ux.md §3): the list body's five states (in flight, error,
// empty, no matches, the flat group across accounts), the invitations group
// first, the bottom actions (Create workspace, Workspace settings; no account
// tab, no New account), and the hand-off choreography (a `+` tap dismisses
// and only then opens the web hand-off to `/new`, never `?account=`).
// Real: the sheet body, the invitations group, `useSheetOpenMove` +
// `useCloseThen` (the choreography under test) and the switcher helpers.
// Every import that needs a native runtime is a stub.

const source = readFileSync(`${import.meta.dir}/ProjectSwitcherSheet.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

// The choreography's observable: every present/dismiss the sheet module sees.
const sheetCalls: string[] = [];
let workspaceRows: unknown[] = [];
let workspacesPending = false;
let workspacesFail = false;
let invitesData: unknown[] | undefined = [];
const pushCalls: string[] = [];
let webCreateUrl: string | null = null;
let searchInput: ((text: string) => void) | null = null;

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
  '@/lib/icons': { GearSixIcon: host('GearSixIcon'), PlusIcon: host('PlusIcon') },
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
  // English defaults with `{{name}}` interpolation, like the app's i18n.
  '@/contexts': {
    useLanguage: () => ({
      t: (key: string, opt?: string | { defaultValue?: string; [k: string]: unknown }) =>
        typeof opt === 'string'
          ? opt
          : (opt?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opt?.[k] ?? '')),
    }),
  },
  '@/lib/haptics': { haptics: { tap() {}, selection() {}, medium() {}, warning() {} } },
  '@/lib/projects/hooks': {
    // Reads the mutable module state, so a test can fail or hold the lists.
    useWorkspaces: () => ({
      rows: workspaceRows,
      isPending: workspacesPending,
      isError: workspacesFail,
      refetch: async () => {},
    }),
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
  '@/components/projects/WorkspaceInvitations',
  '@/lib/ui/sheet-open',
  '@/lib/projects/switcher',
  '@/lib/invites/invite-landing',
  '@/lib/projects/web-project-links',
  // React-only; outside a real sheet it reads "settled", so every row renders.
  '@/components/kortix/sheet-settled',
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
const ROW = (id: string, name: string, account = ACCOUNT) => ({
  project: { project_id: id, account_id: account.account_id, name },
  account,
});

let tree: any;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  sheetCalls.length = 0;
  pushCalls.length = 0;
  workspaceRows = [];
  workspacesPending = false;
  workspacesFail = false;
  invitesData = [];
  webCreateUrl = null;
  searchInput = null;
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
      tree = create(React.createElement(ProjectSwitcherSheet, { open: false } as never));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(sheetCalls).toEqual([]);
  });

  test('open presents one flat list across accounts, the open workspace checked, then the actions', async () => {
    workspaceRows = [ROW('p-1', 'Acme'), ROW('p-2', 'Globex', OTHER), ROW('p-3', 'Globex Labs', OTHER)];
    await openAs({ currentProjectId: 'p-1' });
    expect(sheetCalls).toContain('present');
    const labels = rows().map((r: any) => r.label);
    // No account headings, no account names as rows, no New account.
    expect(labels).toEqual(['Acme', 'Globex', 'Globex Labs', 'Create workspace']);
    expect(rows()[0].checked).toBe(true);
    expect(rows()[1].checked).toBe(false);
    // Every row presses; tapping the open workspace closes instead of re-navigating.
    expect(typeof rows()[0].onPress).toBe('function');
    expect(texts()).not.toContain('New account');
  });

  test('inside a workspace: "Workspace settings" closes the sheet and opens the settings page', async () => {
    workspaceRows = [ROW('p-1', 'Acme')];
    let opened = 0;
    await openAs({ currentProjectId: 'p-1', onOpenWorkspaceSettings: () => (opened += 1) });
    const settings = rows().find((r: any) => r.label === 'Workspace settings');
    expect(settings).toBeTruthy();
    act(() => settings.onPress());
    expect(sheetCalls).toContain('dismiss');
    expect(opened).toBe(1);
  });

  test('the lists still loading: the loader, never the empty state', async () => {
    workspacesPending = true;
    await openAs();
    expect(tree.root.findAll((n: any) => n.type === 'KortixLoader')).toHaveLength(1);
    expect(texts()).not.toContain('No workspaces yet');
  });

  test('no workspace: the empty line, and Create workspace stays', async () => {
    await openAs();
    expect(texts()).toContain('No workspaces yet');
    expect(rows().map((r: any) => r.label)).toEqual(['Create workspace']);
  });

  test('every list failed: the error line with a retry', async () => {
    workspacesFail = true;
    await openAs();
    expect(texts()).toContain("Couldn't load workspaces");
  });

  test('a query that matches nothing: the no-matches line', async () => {
    workspaceRows = Array.from({ length: 3 }, (_, i) => ROW(`p-${i}`, `Workspace ${i}`));
    await openAs();
    // Search shows always in the switcher (ux.md §3).
    expect(typeof searchInput).toBe('function');
    act(() => searchInput!('zzz'));
    expect(rows().map((r: any) => r.label)).toEqual(['Create workspace']);
    expect(texts()).toContain('No matches for "zzz"');
  });

  test('the invitations group renders first, each row with Join (KRTX-1731)', async () => {
    invitesData = [
      { invite_id: 'inv-1', account_name: 'Globex', inviter_email: 'ada@example.com', initial_role: 'admin', projects: [] },
    ];
    workspaceRows = [ROW('p-1', 'Acme')];
    await openAs();
    const groups = tree.root.findAll((n: any) => n.type === 'Group').map((n: any) => n.props);
    expect(groups[0].title).toBe('Invitations');
    const invite = rows()[0];
    expect(invite.label).toBe('Globex');
    expect(invite.value).toBe('Join');
    expect(invite.description).toBe('ada@example.com · Admin');
    act(() => invite.onPress());
    expect(pushCalls).toHaveLength(1);
  });

  test('a `+` tap dismisses the sheet first, then opens the web hand-off to /workspaces/new', async () => {
    workspaceRows = [ROW('p-1', 'Acme')];
    await openAs({ currentProjectId: 'p-1' });
    const add = tree.root.findAll(
      (n: any) => n.type === 'Button' && n.props.accessibilityLabel === 'Create workspace',
    );
    expect(add).toHaveLength(1);
    act(() => add[0].props.onPress());
    expect(sheetCalls).toContain('dismiss');
    expect(webCreateUrl).toBe('https://kortix.test/workspaces/new');
  });
});
