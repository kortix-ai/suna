import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { createElement, type ReactElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `NotificationHost` against fakes: the SDK inbox, the auth client, Web Push,
 * the service worker container, the window clock and the page visibility.
 * Each test pins one KRTX-1742 review fix, or the `notification_center` gate.
 */

// ── fakes ──────────────────────────────────────────────────────────────────
let rows: InboxNotification[] = [];
const markReadCalls: string[][] = [];
let refetches = 0;
let inboxReads = 0;
const refetch = async () => {
  refetches += 1;
};
mock.module('@kortix/sdk/react', () => ({
  useNotificationInbox: () => {
    inboxReads += 1;
    return {
      data: { notifications: rows, unread_count: 0, next_before: null },
      refetch,
      markRead: async (ids: string[]) => {
        markReadCalls.push(ids);
      },
    };
  },
  useNotificationPreferences: () => ({ data: preferences }),
}));
let preferences: { kinds: Record<string, { push: boolean; email: boolean }> } | undefined;

/** The `notification_center` flag, and the project id the host asked about. */
let center = true;
const centerAsked: (string | null | undefined)[] = [];
mock.module('./use-notification-center', () => ({
  useNotificationHostGate: (projectId?: string | null) => {
    centerAsked.push(projectId);
    return center;
  },
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
let user: { id: string } | null = { id: 'user-1' };
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user, supabase }),
}));

let supported = true;
let subscribed = false;
const syncCalls: boolean[] = [];
const ensureCalls: string[] = [];
let reregisters = 0;
let detects = 0;
mock.module('./web-push', () => ({
  webPushSupported: () => supported,
  hasWebPushSubscription: () => subscribed,
  wantsWebPush: (input: { supported: boolean; enabled: boolean; permission: string }) =>
    input.supported && input.enabled && input.permission === 'granted',
  syncWebPush: async (want: boolean) => {
    syncCalls.push(want);
  },
  ensureWebPush: async (userId: string) => {
    ensureCalls.push(userId);
  },
  reregisterWebPush: async () => {
    reregisters += 1;
  },
  detectWebPush: async () => {
    detects += 1;
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
let pathname = '/projects/p1';
mock.module('next/navigation', () => ({ useSearchParams: () => null, usePathname: () => pathname }));
const sent: { fromInbox?: boolean }[] = [];
const mirrored: unknown[] = [];
mock.module('@/lib/web-notifications', () => ({
  isTabHidden: () => true,
  isViewingSession: () => false,
  sendWebNotification: (payload: { fromInbox?: boolean }) => {
    sent.push(payload);
    return null;
  },
  setServerPushPreferences: (kinds: unknown) => {
    mirrored.push(kinds);
  },
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
  inboxReads = 0;
  center = true;
  centerAsked.length = 0;
  pathname = '/projects/p1';
  sent.length = 0;
  mirrored.length = 0;
  supported = true;
  subscribed = false;
  syncCalls.length = 0;
  ensureCalls.length = 0;
  reregisters = 0;
  detects = 0;
  user = { id: 'user-1' };
  preferences = undefined;
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
  test('the MFA step-up registers the existing subscription again', async () => {
    await mount();
    expect(ensureCalls).toEqual(['user-1']);
    await act(async () => {
      for (const listener of authListeners) listener('TOKEN_REFRESHED');
    });
    expect(reregisters).toBe(0);
    await act(async () => {
      for (const listener of authListeners) listener('MFA_CHALLENGE_VERIFIED');
    });
    expect(reregisters).toBe(1);
    expect(ensureCalls).toEqual(['user-1']);
    expect(syncCalls).toEqual([]);
  });

  test('with browser notifications off the step-up registers nothing', async () => {
    await mount();
    await act(async () => {
      useWebNotificationStore.setState({
        preferences: { ...useWebNotificationStore.getState().preferences, enabled: false },
      });
    });
    await act(async () => {
      for (const listener of authListeners) listener('MFA_CHALLENGE_VERIFIED');
    });
    expect(reregisters).toBe(0);
  });

  test('without Web Push support nothing listens for the step-up', async () => {
    supported = false;
    await mount();
    expect(authListeners.size).toBe(0);
    expect(syncCalls).toEqual([]);
    expect(ensureCalls).toEqual([]);
    expect(detects).toBe(0);
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

/**
 * KRTX-1742 behind `notification_center`: with the flag off for the project in
 * the URL, the host is the pre-KRTX-1742 nothing, except that a "no" to
 * browser notifications still removes a subscription made elsewhere.
 */
describe('NotificationHost — the notification_center flag', () => {
  test('asks about the project in the URL, and about none on an account page', async () => {
    await mount();
    expect(centerAsked.at(-1)).toBe('p1');
    pathname = '/projects';
    await rerender();
    expect(centerAsked.at(-1)).toBeNull();
  });

  test('flag off: no inbox, no subscription, no clock, no worker listener', async () => {
    center = false;
    preferences = { kinds: { turn_done: { push: false, email: false } } };
    await mount();
    expect(inboxReads).toBe(0);
    expect(syncCalls).toEqual([]);
    expect(ensureCalls).toEqual([]);
    expect(intervals).toHaveLength(0);
    expect(workerListeners.size).toBe(0);
    expect(mirrored).toStrictEqual([]);
    // It only reads whether this browser already holds a subscription.
    expect(detects).toBe(1);
  });

  test('flag off: the MFA step-up still registers a subscription made on a flag-on project', async () => {
    center = false;
    await mount();
    await act(async () => {
      for (const listener of authListeners) listener('MFA_CHALLENGE_VERIFIED');
    });
    expect(reregisters).toBe(1);
    expect(ensureCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test('flag off: turning browser notifications off still removes the subscription', async () => {
    center = false;
    await mount();
    await act(async () => {
      useWebNotificationStore.setState({
        preferences: { ...useWebNotificationStore.getState().preferences, enabled: false },
      });
    });
    expect(syncCalls).toEqual([false]);
  });

  test('leaving a flag-on project for a flag-off one keeps the subscription and the Push mirror', async () => {
    const kinds = { turn_done: { push: false, email: false } };
    preferences = { kinds };
    await mount();
    expect(ensureCalls).toEqual(['user-1']);
    expect(mirrored).toStrictEqual([kinds]);
    center = false;
    pathname = '/projects/p2';
    await rerender();
    expect(syncCalls).toEqual([]);
    // A flag-on project's payload in this tab still obeys the saved choice.
    expect(mirrored).toStrictEqual([kinds]);
  });

  test('a mirror stays while the preferences load again', async () => {
    const kinds = { turn_done: { push: false, email: false } };
    preferences = { kinds };
    await mount();
    center = false;
    await rerender();
    preferences = undefined;
    center = true;
    await rerender();
    expect(mirrored).toStrictEqual([kinds]);
  });

  test('sign-out and a change of person clear the Push mirror', async () => {
    const kinds = { turn_done: { push: false, email: false } };
    preferences = { kinds };
    await mount();
    user = { id: 'user-2' };
    await rerender();
    expect(mirrored).toStrictEqual([kinds, undefined, kinds]);
    user = null;
    await rerender();
    expect(mirrored).toStrictEqual([kinds, undefined, kinds, undefined]);
  });

  test('the gated part asks for the subscription on each mount; web-push.ts skips an unchanged one', async () => {
    await mount();
    center = false;
    await rerender();
    center = true;
    await rerender();
    expect(ensureCalls).toEqual(['user-1', 'user-1']);
    expect(syncCalls).toEqual([]);
  });

  test('an arrival shown as an OS notification is marked as an inbox row', async () => {
    const world = globalThis as { Notification?: unknown };
    world.Notification = { permission: 'granted' };
    try {
      await mount();
      rows = [row()];
      await rerender();
      expect(sent).toHaveLength(1);
      expect(sent[0].fromInbox).toBe(true);
    } finally {
      delete world.Notification;
    }
  });
});
