import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The Notifications page (KRTX-1742): rows, Mark all as read, a tap that marks
// the row read and opens its session or project, and the loading, error and
// empty states. Real: the inbox rules, the relative time, the push store, the
// SDK types. Every other import is a stub.

const source = readFileSync(`${import.meta.dir}/InboxPage.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

let inbox: any;
let inboxOptions: any;
let header: any;
let rowProps: any[] = [];
const calls: { name: string; args: unknown[] }[] = [];
const spy = (name: string) => (...args: unknown[]) => {
  calls.push({ name, args });
};
const seen = (name: string) => calls.filter((call) => call.name === name).map((call) => call.args);

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), RefreshControl: Empty },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@kortix/sdk/react': {
    useNotificationInbox: (options: unknown) => {
      inboxOptions = options;
      return inbox;
    },
  },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/kortix/kortix-loader': { KortixLoader: host('Loader') },
  '@/components/kortix/settings-list': {
    SettingsHeader: (props: any) => {
      header = props;
      return React.createElement('Header', null, props.right);
    },
    SettingsPage: host('Page'),
    SettingsGroup: host('Group'),
    SettingsRow: (props: any) => {
      rowProps.push(props);
      return React.createElement('Row', { label: props.label });
    },
  },
  '@/components/kortix/toast-provider': { useToast: () => ({ error: spy('toastError') }) },
  '@/components/session/ProjectRoutes': {
    useProjectRoute: () => ({ openDrawer: spy('openDrawer'), isDrawerOpen: false }),
    useCoveringRoute: spy('coveringRoute'),
  },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'user-1' } }) },
  '@/lib/haptics': { haptics: { tap() {} } },
  '@/lib/utils/index': { cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') },
  '@/lib/utils/theme': { THEME: { light: { mutedForeground: 'm' }, dark: { mutedForeground: 'm' } } },
};
const real = new Set(['react', '@kortix/sdk', '@/lib/notifications/inbox', '@/lib/session/session-list', '@/stores/push-store']);
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
  mock.module(name, () => values);
}

let InboxPage: typeof import('./InboxPage').InboxPage;
let usePushStore: typeof import('@/stores/push-store').usePushStore;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  InboxPage = (await import('./InboxPage')).InboxPage;
  usePushStore = (await import('@/stores/push-store')).usePushStore;
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const QUESTION = {
  id: 'note-1',
  kind: 'question',
  title: 'Fix the login page',
  body: 'Which branch?',
  project_id: 'proj-2',
  project_name: 'Website',
  session_id: 'sess-1',
  trigger_slug: null,
  actor_user_id: null,
  url: '/projects/proj-2/sessions/sess-1?notification=note-1',
  read: false,
  created_at: minutesAgo(5),
};
const ALERT = {
  ...QUESTION,
  id: 'note-2',
  kind: 'automation_failed',
  title: 'Nightly report',
  body: 'Credits ran out',
  project_name: 'Ops',
  project_id: 'proj-3',
  session_id: null,
  trigger_slug: 'nightly-report',
  read: true,
  created_at: minutesAgo(120),
};

function inboxWith(rows: any[], extra: Record<string, unknown> = {}) {
  return {
    data: { notifications: rows, unread_count: rows.filter((row) => !row.read).length, next_before: null },
    unreadCount: rows.filter((row) => !row.read).length,
    isPending: false,
    isError: false,
    refetch: spy('refetch'),
    markRead: async (ids: string[]) => spy('markRead')(ids),
    markAllRead: async () => spy('markAllRead')(),
    ...extra,
  };
}

let tree: any;
beforeEach(() => {
  calls.length = 0;
  rowProps = [];
  header = inboxOptions = undefined;
  usePushStore.setState({ pendingOpen: null });
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});
async function render() {
  await act(async () => {
    tree = create(React.createElement(InboxPage));
  });
}
const texts = () => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);

describe('InboxPage', () => {
  test('reads the shared inbox query for the signed-in user and covers project home', async () => {
    inbox = inboxWith([QUESTION, ALERT]);
    await render();
    expect(inboxOptions).toEqual({ userId: 'user-1', limit: 50 });
    expect(seen('coveringRoute')).toHaveLength(1);
    expect(header.title).toBe('Notifications');
    header.onOpenMenu();
    expect(seen('openDrawer')).toHaveLength(1);
  });

  test('one row per notification: unread dot, title, kind and project, time', async () => {
    inbox = inboxWith([QUESTION, ALERT]);
    await render();
    expect(rowProps.map((row) => [row.label, row.description, row.value])).toEqual([
      ['Fix the login page', 'Question · Website', '5m'],
      ['Nightly report', 'Failure alert · Ops', '2h'],
    ]);
    expect(rowProps.map((row) => row.leading.props.unread)).toEqual([true, false]);
    expect(rowProps[0].accessibilityLabel).toBe('Question, Fix the login page, Website, 5 minutes ago, unread');
    expect(rowProps.map((row) => row.accessibilityHint)).toEqual(['Opens the session', 'Opens the project']);
    expect(rowProps.every((row) => row.right === null)).toBe(true);
  });

  test('a tap marks an unread row read and opens its session through the push store', async () => {
    inbox = inboxWith([QUESTION]);
    await render();
    await act(async () => rowProps[0].onPress());
    expect(seen('markRead')).toEqual([[['note-1']]]);
    expect(usePushStore.getState().pendingOpen).toEqual({ projectId: 'proj-2', sessionId: 'sess-1', navigated: false });
  });

  test('a tap on a read automation alert opens its project and writes nothing', async () => {
    inbox = inboxWith([ALERT]);
    await render();
    await act(async () => rowProps[0].onPress());
    expect(seen('markRead')).toEqual([]);
    expect(usePushStore.getState().pendingOpen).toEqual({ projectId: 'proj-3', sessionId: null, navigated: false });
  });

  test('Mark all as read shows while a row is unread; a failed write says so', async () => {
    inbox = inboxWith([QUESTION]);
    await render();
    const button = header.right;
    expect(button.props.children.props.children).toBe('Mark all as read');
    await act(async () => button.props.onPress());
    expect(seen('markAllRead')).toHaveLength(1);
    expect(seen('toastError')).toEqual([]);

    inbox = inboxWith([QUESTION], {
      markAllRead: async () => {
        throw new Error('offline');
      },
    });
    await act(async () => tree.update(React.createElement(InboxPage)));
    await act(async () => header.right.props.onPress());
    expect(seen('toastError')).toEqual([['Unable to mark notifications as read. Try again.']]);
  });

  test('nothing unread: no Mark all as read', async () => {
    inbox = inboxWith([ALERT]);
    await render();
    expect(header.right).toBeNull();
  });

  test('loading shows the loader, an empty inbox says so, a failed load offers Try again', async () => {
    inbox = inboxWith([], { data: undefined, isPending: true });
    await render();
    expect(tree.root.findAll((node: any) => node.type === 'Loader')).toHaveLength(1);

    inbox = inboxWith([]);
    await act(async () => tree.update(React.createElement(InboxPage)));
    expect(texts()).toEqual(['No notifications yet']);

    inbox = inboxWith([], { data: undefined, isError: true });
    await act(async () => tree.update(React.createElement(InboxPage)));
    expect(texts()).toEqual(['Unable to load notifications.', 'Try again']);
    const retry = tree.root.findAll((node: any) => node.type === 'Button')[0];
    await act(async () => retry.props.onPress());
    expect(seen('refetch')).toHaveLength(1);
  });
});
