import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { createElement, type ReactElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `NotificationHost` against fakes: the SDK inbox, the auth client, Web Push,
 * the service worker container, the window clock and the page visibility.
 * Each test pins one KRTX-1742 review fix.
 */

// ── fakes ──────────────────────────────────────────────────────────────────
let rows: InboxNotification[] = [];
const markReadCalls: string[][] = [];
let refetches = 0;
const refetch = async () => {
  refetches += 1;
};
mock.module('@kortix/sdk/react', () => ({
  useNotificationInbox: () => ({
    data: { notifications: rows, unread_count: 0, next_before: null },
    refetch,
    markRead: async (ids: string[]) => {
      markReadCalls.push(ids);
    },
  }),
  useNotificationPreferences: () => ({ data: undefined }),
}));

type AuthListener = (event: string) => void;
const authListeners = new Set<AuthListener>();
const supabase = {
  auth: {
    onAuthStateChange: (listener: AuthListener) => {
      authListeners.add(listener);
      return { data: { subscription: { unsubscribe: () => authListeners.delete(listener) } } };
    },
  },
};
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, supabase }),
}));

let supported = true;
let subscribed = false;
const syncCalls: boolean[] = [];
mock.module('./web-push', () => ({
  webPushSupported: () => supported,
  hasWebPushSubscription: () => subscribed,
  wantsWebPush: (input: { supported: boolean; enabled: boolean; permission: string }) =>
    input.supported && input.enabled && input.permission === 'granted',
  syncWebPush: async (want: boolean) => {
    syncCalls.push(want);
  },
}));

const toasts: { title: string; button: ReactElement<{ children: string }> }[] = [];
mock.module('@/components/ui/toast', () => ({
  infoToast: (title: string, options: { button: ReactElement<{ children: string }> }) => {
    toasts.push({ title, button: options.button });
  },
  dismissToast: () => {},
}));
mock.module('@/components/ui/button', () => ({ Button: 'button' }));
const t = (key: string) => key;
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => t }));
mock.module('@/lib/navigation/router-bridge', () => ({ softNavigate: () => {} }));
mock.module('next/navigation', () => ({ useSearchParams: () => null }));
mock.module('@/lib/web-notifications', () => ({
  isTabHidden: () => true,
  isViewingSession: () => false,
  sendWebNotification: () => null,
  setServerPushPreferences: () => {},
}));

// ── minimum browser surface ────────────────────────────────────────────────
const intervals: { tick: () => void; ms: number }[] = [];
let visibilityState: 'visible' | 'hidden' = 'hidden';
let focused = false;
const world = globalThis as { window?: unknown; document?: unknown };
world.window = {
  setInterval: (tick: () => void, ms: number) => intervals.push({ tick, ms }),
  clearInterval: () => {},
  location: { pathname: '/projects/p1', search: '', hash: '' },
  history: { replaceState: () => {} },
};
world.document = {
  get visibilityState() {
    return visibilityState;
  },
  hasFocus: () => focused,
};
const workerListeners = new Set<(event: { data: unknown }) => void>();
Object.defineProperty(globalThis.navigator, 'serviceWorker', {
  configurable: true,
  value: {
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => workerListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
      workerListeners.delete(listener),
  },
});

const { NotificationHost } = await import('./notification-host');
const { useWebNotificationStore } = await import('@/stores/web-notification-store');

let next = 0;
function row(overrides: Partial<InboxNotification> = {}): InboxNotification {
  next += 1;
  const id = `0192f0c4-0000-7000-8000-${String(next).padStart(12, '0')}`;
  return {
    id,
    kind: 'automation_failed',
    title: 'Daily summary',
    body: '',
    project_id: 'p1',
    project_name: 'Website',
    session_id: null,
    trigger_slug: 'reminder.0a1b2c3d4e5f',
    actor_user_id: null,
    url: `/projects/p1/reminders?notification=${id}`,
    read: false,
    created_at: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

let renderer: ReturnType<typeof create> | null = null;
async function mount() {
  await act(async () => {
    renderer = create(createElement(NotificationHost));
  });
}
const rerender = () => act(async () => renderer?.update(createElement(NotificationHost)));

beforeEach(() => {
  rows = [];
  markReadCalls.length = 0;
  refetches = 0;
  supported = true;
  subscribed = false;
  syncCalls.length = 0;
  toasts.length = 0;
  intervals.length = 0;
  visibilityState = 'hidden';
  focused = false;
  useWebNotificationStore.setState({
    preferences: { ...useWebNotificationStore.getInitialState().preferences, enabled: true },
    permission: 'granted',
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe('NotificationHost', () => {
  test('the MFA step-up registers this browser for Web Push again', async () => {
    await mount();
    expect(syncCalls).toEqual([true]);
    await act(async () => {
      for (const listener of authListeners) listener('TOKEN_REFRESHED');
    });
    expect(syncCalls).toEqual([true]);
    await act(async () => {
      for (const listener of authListeners) listener('MFA_CHALLENGE_VERIFIED');
    });
    expect(syncCalls).toEqual([true, true]);
  });

  test('without Web Push support nothing listens for the step-up', async () => {
    supported = false;
    await mount();
    expect(authListeners.size).toBe(0);
    expect(syncCalls).toEqual([]);
  });

  test('a hidden window without Web Push checks the inbox every 60 s', async () => {
    await mount();
    const clock = intervals.find((interval) => interval.ms === 60_000);
    expect(clock).toBeDefined();
    clock?.tick();
    expect(refetches).toBe(1);

    visibilityState = 'visible';
    clock?.tick();
    visibilityState = 'hidden';
    subscribed = true;
    clock?.tick();
    subscribed = false;
    await act(async () => {
      useWebNotificationStore.setState({ permission: 'default' });
    });
    clock?.tick();
    expect(refetches).toBe(1);
  });

  test("the service worker's message for a clicked notification marks that row read", async () => {
    await mount();
    const id = '0192f0c4-0000-7000-8000-00000000abcd';
    await act(async () => {
      for (const listener of workerListeners) {
        listener({ data: { type: 'other', url: `/projects/p1?notification=${id}` } });
        listener({ data: { type: 'kortix:notification-open', url: '/projects/p1?notification=n1' } });
        listener({ data: { type: 'kortix:notification-open', url: `https://app.example.test/projects/p1?notification=${id}` } });
      }
    });
    expect(markReadCalls).toEqual([[id]]);
  });

  test('a reminder alert toasts "Open reminders"; a trigger alert, "Open triggers"', async () => {
    focused = true;
    rows = [];
    await mount();
    rows = [
      row(),
      row({ trigger_slug: 'nightly', url: '/projects/p1/customize/triggers?notification=n2' }),
    ];
    await rerender();
    expect(toasts.map((toast) => toast.button.props.children)).toEqual([
      'arrival.openReminders',
      'arrival.openTriggers',
    ]);
  });
});
