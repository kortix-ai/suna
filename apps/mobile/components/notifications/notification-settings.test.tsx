import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// Settings → Notifications (app/(settings)/notifications.tsx, KRTX-1742).
// Without a `notification_center` project: the page from before KRTX-1742,
// this phone's switches only, no request. With one: this phone's two switches,
// then the 7 Push switches from the user's record (a session kind ANDed with
// this phone's switch); no Email switch on mobile. Real: the kinds, the kind
// labels, the push rules, this phone's store. Every other import is a stub.

const SCREEN = `${import.meta.dir}/../../app/(settings)/notifications.tsx`;
const source = readFileSync(SCREEN, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

let record: any;
let recordOptions: any;
let centerOn = false;
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
  '@/lib/notifications/registration': { carryOverLegacyKinds: async () => spy('carryOver')() },
  '@/lib/projects/hooks': { useHasNotificationCenterProject: () => centerOn },
};
const real = new Set([
  'react',
  '@kortix/sdk',
  '@/lib/notifications/inbox',
  '@/lib/notifications/push',
  '@/stores/notification-store',
]);
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

const PHONE = { enabled: true, onCompletion: true, onError: true, onQuestion: true, onPermission: true, playSound: true };

let tree: any;
beforeEach(() => {
  calls.length = 0;
  rows = [];
  groups = [];
  record = recordWith();
  recordOptions = undefined;
  centerOn = true;
  useNotificationStore.setState({ preferences: PHONE });
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

describe('Settings → Notifications without a notification_center project', () => {
  beforeEach(() => {
    centerOn = false;
  });

  test("the page from before KRTX-1742: this phone's 4 per-kind switches, no request", async () => {
    useNotificationStore.setState({ preferences: { ...PHONE, onError: false } });
    await render();
    expect(recordOptions).toBeUndefined();
    expect(seen('carryOver')).toEqual([]);
    expect(groups).toEqual(['General', 'Notification types', 'This device']);
    expect(rows.map((props) => props.label)).toEqual([
      'Notifications',
      'Play sound',
      'Task completions',
      'Errors',
      'Questions',
      'Permission requests',
      'Device settings',
    ]);
    expect(row('Errors').right.props.checked).toBe(false);
    expect(row('Questions').right.props.checked).toBe(true);
  });

  test('a switch changes this phone only', async () => {
    await render();
    await act(async () => row('Questions').right.props.onCheckedChange(false));
    await act(async () => row('Play sound').right.props.onCheckedChange(false));
    expect(useNotificationStore.getState().preferences).toEqual({ ...PHONE, onQuestion: false, playSound: false });
    expect(seen('update')).toEqual([]);
  });

  test('with this phone off, Play sound and the per-kind switches hide', async () => {
    useNotificationStore.setState({ preferences: { ...PHONE, enabled: false } });
    await render();
    expect(groups).toEqual(['General', 'This device']);
    expect(rows.map((props) => props.label)).toEqual(['Notifications', 'Device settings']);
  });

  test('a flag-on project appears: the page switches to the record', async () => {
    await render();
    expect(groups).toEqual(['General', 'Notification types', 'This device']);
    centerOn = true;
    await render();
    expect(groups).toEqual(['General', 'Push', 'This device']);
    expect(recordOptions).toEqual({ userId: 'user-1' });
  });
});

describe('Settings → Notifications with a notification_center project', () => {
  test("this phone's switches, then one Push switch per kind from the user's record, no Email", async () => {
    await render();
    expect(recordOptions).toEqual({ userId: 'user-1' });
    expect(seen('carryOver')).toHaveLength(1);
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

  test("a session kind shows on only when the record and this phone's switch are both on", async () => {
    useNotificationStore.setState({ preferences: { ...PHONE, onQuestion: false, onError: false } });
    await render();
    // Record on, phone off.
    expect(row('Question').right.props.checked).toBe(false);
    // Record off, phone off.
    expect(row('Turn failed').right.props.checked).toBe(false);
    // Record on, phone on.
    expect(row('Turn finished').right.props.checked).toBe(true);
    // A new kind has no phone switch: the record alone.
    expect(row('Shared with you').right.props.checked).toBe(true);
  });

  test("a session-kind switch saves the record and this phone's switch; a new kind saves the record", async () => {
    useNotificationStore.setState({ preferences: { ...PHONE, onError: false } });
    await render();
    await act(async () => row('Turn failed').right.props.onCheckedChange(true));
    await act(async () => row('Turn finished').right.props.onCheckedChange(false));
    await act(async () => row('Recovery alert').right.props.onCheckedChange(true));
    expect(seen('update')).toEqual([
      [{ kinds: { turn_error: { push: true } } }],
      [{ kinds: { turn_done: { push: false } } }],
      [{ kinds: { automation_recovered: { push: true } } }],
    ]);
    expect(useNotificationStore.getState().preferences).toEqual({ ...PHONE, onCompletion: false });
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
    expect(useNotificationStore.getState().preferences).toEqual({ ...PHONE, playSound: false });
    await act(async () => row('Notifications').right.props.onCheckedChange(false));
    expect(useNotificationStore.getState().preferences.enabled).toBe(false);
    expect(seen('update')).toEqual([]);
  });

  test('with this phone off, Play sound and the Push switches hide', async () => {
    useNotificationStore.setState({ preferences: { ...PHONE, enabled: false } });
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
