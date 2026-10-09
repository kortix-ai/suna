import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The bridge's notification wiring (KRTX-1742): a tap marks its inbox row read
// and opens its session or project; a push that arrives while the app is open
// refetches the inbox.
// Real: the push rules (lib/notifications/push) and the push store. Every
// other import is a stub.

const source = readFileSync(`${import.meta.dir}/PushNotificationsBridge.tsx`, 'utf8');
const Empty = () => null;

const listeners: { response?: (response: unknown) => void; received?: (notification: unknown) => void } = {};
const reads: unknown[] = [];
const invalidated: unknown[] = [];
let readFails = false;

const Notifications = {
  DEFAULT_ACTION_IDENTIFIER: 'default',
  AndroidImportance: { HIGH: 4 },
  setNotificationHandler() {},
  setNotificationChannelAsync: async () => {},
  addNotificationResponseReceivedListener: (fn: (response: unknown) => void) => {
    listeners.response = fn;
    return { remove() {} };
  },
  addNotificationReceivedListener: (fn: (notification: unknown) => void) => {
    listeners.received = fn;
    return { remove() {} };
  },
  getLastNotificationResponse: () => null,
  clearLastNotificationResponse() {},
};
const queryClient = {
  invalidateQueries: async (filters: unknown) => {
    invalidated.push(filters);
  },
};

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { AppState: { currentState: 'active' }, Platform: { OS: 'ios' } },
  'expo-router': {
    useGlobalSearchParams: () => ({ id: 'proj-1' }),
    useNavigationContainerRef: () => ({ dispatch() {} }),
    useRouter: () => ({ replace() {} }),
    useSegments: () => ['projects', '[id]'],
  },
  'expo-router/react-navigation': { StackActions: { replace: () => ({}) } },
  '@tanstack/react-query': { useQueryClient: () => queryClient },
  '@kortix/sdk': {
    // lib/notifications/push (real) reads the kinds.
    INBOX_NOTIFICATION_KINDS: ['turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered'],
    markNotificationsRead: async (input: unknown) => {
      reads.push(input);
      if (readFails) throw new Error('offline');
      return { updated: 1, unread_count: 0 };
    },
  },
  '@kortix/sdk/react': { qk: { notifications: { scope: () => ['kx', 'notifications'] } } },
  '@/contexts': { useAuthContext: () => ({ isAuthenticated: true, mfaRequired: false }) },
  '@/lib/logger': { log: { warn() {}, log() {}, error() {} } },
  '@/lib/notifications/registration': {
    getNotifications: () => Notifications,
    remotePushSupported: () => false,
    syncPushPreferences: async () => {},
    syncPushRegistration: async () => null,
  },
  '@/lib/projects/switcher': { projectHref: (id: string) => ({ pathname: '/projects/[id]', params: { id } }) },
  '@/lib/utils/app-resume': { addResumeListener: () => () => {} },
  '@/stores/notification-store': { useNotificationStore: { subscribe: () => () => {} } },
};
const real = new Set(['react', '@/lib/notifications/push', '@/stores/push-store']);
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
  mock.module(name, () => values);
}

let Bridge: typeof import('./PushNotificationsBridge').PushNotificationsBridge;
let usePushStore: typeof import('@/stores/push-store').usePushStore;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Bridge = (await import('./PushNotificationsBridge')).PushNotificationsBridge;
  usePushStore = (await import('@/stores/push-store')).usePushStore;
});

let tree: any;
let responseId = 0;
beforeEach(async () => {
  reads.length = 0;
  invalidated.length = 0;
  readFails = false;
  usePushStore.setState({ pendingOpen: null });
  await act(async () => {
    tree = create(React.createElement(Bridge));
  });
});
afterEach(async () => {
  await act(async () => tree.unmount());
});

const SESSION_PUSH = {
  notificationId: 'note-1',
  kind: 'question',
  type: 'question',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  triggerSlug: null,
  url: '/projects/proj-1/sessions/sess-1?notification=note-1',
};
const ALERT_PUSH = { ...SESSION_PUSH, notificationId: 'note-2', kind: 'automation_failed', type: 'automation_failed', sessionId: null };
const content = (data: unknown) => ({ request: { identifier: `push-${++responseId}`, content: { data } } });
const tap = (data: unknown) => act(async () => listeners.response?.({ actionIdentifier: 'default', notification: content(data) }));
const arrive = (data: unknown) => act(async () => listeners.received?.(content(data)));

describe('PushNotificationsBridge', () => {
  test('a tap marks its inbox row read, refetches the inbox, and opens its session', async () => {
    await tap(SESSION_PUSH);
    expect(reads).toEqual([{ ids: ['note-1'] }]);
    expect(invalidated).toEqual([{ queryKey: ['kx', 'notifications'] }]);
    expect(usePushStore.getState().pendingOpen).toMatchObject({ projectId: 'proj-1', sessionId: 'sess-1' });
  });

  test('a tap on an automation alert opens its project', async () => {
    await tap(ALERT_PUSH);
    expect(reads).toEqual([{ ids: ['note-2'] }]);
    expect(usePushStore.getState().pendingOpen).toMatchObject({ projectId: 'proj-1', sessionId: null });
  });

  test('a tap on a push from a server before the inbox opens the session and marks nothing', async () => {
    await tap({ type: 'completion', projectId: 'proj-1', sessionId: 'sess-1' });
    expect(reads).toEqual([]);
    expect(usePushStore.getState().pendingOpen).toMatchObject({ projectId: 'proj-1', sessionId: 'sess-1' });
  });

  test('a failed read still opens the session and refetches nothing', async () => {
    readFails = true;
    await tap(SESSION_PUSH);
    expect(reads).toHaveLength(1);
    expect(invalidated).toEqual([]);
    expect(usePushStore.getState().pendingOpen).toMatchObject({ sessionId: 'sess-1' });
  });

  test('a push that arrives while the app is open refetches the inbox and marks nothing', async () => {
    await arrive(SESSION_PUSH);
    expect(reads).toEqual([]);
    expect(invalidated).toEqual([{ queryKey: ['kx', 'notifications'] }]);
  });
});
