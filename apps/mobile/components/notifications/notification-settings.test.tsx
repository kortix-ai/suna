import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// Settings → Notifications (app/(settings)/notifications.tsx, KRTX-1742): this
// phone's two switches stay on the phone; the 7 Push switches are the user's
// record on the server; no Email switch on mobile. Real: the kinds, the kind
// labels, this phone's store. Every other import is a stub.

const SCREEN = `${import.meta.dir}/../../app/(settings)/notifications.tsx`;
const source = readFileSync(SCREEN, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

let record: any;
let recordOptions: any;
let rows: any[] = [];
let groups: string[] = [];
const calls: { name: string; args: unknown[] }[] = [];
const spy = (name: string) => (...args: unknown[]) => {
  calls.push({ name, args });
};
const seen = (name: string) => calls.filter((call) => call.name === name).map((call) => call.args);

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), Linking: { openSettings: spy('openSettings') } },
  '@kortix/sdk/react': {
    useNotificationPreferences: (options: unknown) => {
      recordOptions = options;
      return record;
    },
  },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/ui/switch': { Switch: host('Switch') },
  '@/components/kortix/kortix-loader': { KortixLoader: host('Loader') },
  '@/components/kortix/settings-list': {
    SettingsPage: host('Page'),
    SettingsGroup: ({ title, children }: any) => {
      groups.push(title);
      return React.createElement('Group', null, children);
    },
    SettingsRow: (props: any) => {
      rows.push(props);
      return null;
    },
  },
  '@/components/kortix/toast-provider': { useToast: () => ({ error: spy('toastError') }) },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'user-1' } }) },
  '@/lib/haptics': { haptics: { tap() {}, selection() {} } },
};
const real = new Set(['react', '@kortix/sdk', '@/lib/notifications/inbox', '@/stores/notification-store']);
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
  mock.module(name, () => values);
}

let NotificationsScreen: React.ComponentType;
let useNotificationStore: typeof import('@/stores/notification-store').useNotificationStore;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  NotificationsScreen = (await import(SCREEN)).default;
  useNotificationStore = (await import('@/stores/notification-store')).useNotificationStore;
});

const KINDS = {
  turn_done: { push: true, email: false },
  turn_error: { push: false, email: true },
  question: { push: true, email: true },
  permission: { push: true, email: false },
  shared: { push: true, email: true },
  automation_failed: { push: true, email: true },
  automation_recovered: { push: false, email: false },
};
function recordWith(extra: Record<string, unknown> = {}) {
  return {
    data: { kinds: KINDS, email_available: true },
    isError: false,
    refetch: spy('refetch'),
    update: async (patch: unknown) => spy('update')(patch),
    ...extra,
  };
}

let tree: any;
beforeEach(() => {
  calls.length = 0;
  rows = [];
  groups = [];
  record = recordWith();
  useNotificationStore.setState({ preferences: { enabled: true, playSound: true } });
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});
async function render() {
  rows = [];
  groups = [];
  await act(async () => {
    if (tree) tree.update(React.createElement(NotificationsScreen));
    else tree = create(React.createElement(NotificationsScreen));
  });
}
const row = (label: string) => rows.filter((props) => props.label === label).at(-1);

describe('Settings → Notifications', () => {
  test("this phone's switches, then one Push switch per kind from the user's record, no Email", async () => {
    await render();
    expect(recordOptions).toEqual({ userId: 'user-1' });
    expect(groups).toEqual(['General', 'Push', 'This device']);
    expect(rows.map((props) => props.label)).toEqual([
      'Notifications',
      'Play sound',
      'Turn finished',
      'Turn failed',
      'Question',
      'Permission request',
      'Shared with you',
      'Failure alert',
      'Recovery alert',
      'Device settings',
    ]);
    expect(row('Turn failed').right.props.checked).toBe(false);
    expect(row('Question').right.props.checked).toBe(true);
    expect(row('Recovery alert').right.props.checked).toBe(false);
  });

  test('a Push switch saves that kind on the server', async () => {
    await render();
    await act(async () => row('Turn failed').right.props.onCheckedChange(true));
    await act(async () => row('Turn finished').right.props.onCheckedChange(false));
    expect(seen('update')).toEqual([[{ kinds: { turn_error: { push: true } } }], [{ kinds: { turn_done: { push: false } } }]]);
    expect(seen('toastError')).toEqual([]);
  });

  test('a failed save says so', async () => {
    record = recordWith({
      update: async () => {
        throw new Error('offline');
      },
    });
    await render();
    await act(async () => row('Question').right.props.onCheckedChange(false));
    expect(seen('toastError')).toEqual([['Unable to save the setting. Try again.']]);
  });

  test("this phone's switches stay on the phone", async () => {
    await render();
    await act(async () => row('Play sound').right.props.onCheckedChange(false));
    expect(useNotificationStore.getState().preferences).toEqual({ enabled: true, playSound: false });
    await act(async () => row('Notifications').right.props.onCheckedChange(false));
    expect(useNotificationStore.getState().preferences.enabled).toBe(false);
    expect(seen('update')).toEqual([]);
  });

  test('with this phone off, Play sound and the Push switches hide', async () => {
    useNotificationStore.setState({ preferences: { enabled: false, playSound: true } });
    await render();
    expect(groups).toEqual(['General', 'This device']);
    expect(rows.map((props) => props.label)).toEqual(['Notifications', 'Device settings']);
  });

  test('the record loads with a loader; a failed load offers Try again', async () => {
    record = recordWith({ data: undefined });
    await render();
    expect(tree.root.findAll((node: any) => node.type === 'Loader')).toHaveLength(1);
    expect(groups).toEqual(['General', 'This device']);

    record = recordWith({ data: undefined, isError: true });
    await render();
    const retry = tree.root.findAll((node: any) => node.type === 'Button')[0];
    await act(async () => retry.props.onPress());
    expect(seen('refetch')).toHaveLength(1);
  });

  test('Device settings opens the system settings', async () => {
    await render();
    await act(async () => row('Device settings').onPress());
    expect(seen('openSettings')).toHaveLength(1);
  });
});
