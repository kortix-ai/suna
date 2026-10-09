import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Regression for KRTX-1795 (dogfood journey notif-inapp): a customer watching
 * from another browser tab got zero signal when a turn finished — no toast,
 * no sound, no badge. `sendWebNotification` returned before its in-app
 * channels ever ran, gated on `Notification.permission` and the opt-in
 * preferences, so the DEFAULT profile (browser notifications never enabled)
 * was silent forever, and nothing marked the tab for a returning user.
 *
 * bun test has no DOM. The module under test guards every DOM read with
 * `typeof document === 'undefined'`, which would silently skip the channels
 * under test — so this file installs the minimum browser surface the module
 * actually reads: `document.hidden`/`hasFocus`, `window.location`, and the
 * `Notification` constructor.
 */

// ── spies ──────────────────────────────────────────────────────────────────
const toastCalls: { kind: string; title: string; opts?: Record<string, unknown> }[] = [];
const soundCalls: string[] = [];
const softNavigateCalls: string[] = [];

mock.module('@/components/ui/toast', () => ({
  successToast: (title: string, opts?: Record<string, unknown>) => {
    toastCalls.push({ kind: 'success', title, opts });
  },
  errorToast: (title: string, opts?: Record<string, unknown>) => {
    toastCalls.push({ kind: 'error', title, opts });
  },
  warningToast: (title: string, opts?: Record<string, unknown>) => {
    toastCalls.push({ kind: 'warning', title, opts });
  },
  infoToast: (title: string, opts?: Record<string, unknown>) => {
    toastCalls.push({ kind: 'info', title, opts });
  },
  dismissToast: () => {},
}));

mock.module('@/components/ui/button', () => ({ Button: 'button' }));

mock.module('@/lib/sounds', () => ({
  playSound: (event: string) => {
    soundCalls.push(event);
  },
}));

mock.module('@/lib/navigation/router-bridge', () => ({
  softNavigate: (href: string) => {
    softNavigateCalls.push(href);
  },
}));

let webPushOn = false;
mock.module('@/features/notifications/web-push', () => ({
  hasWebPushSubscription: () => webPushOn,
}));

// ── minimum browser surface ────────────────────────────────────────────────
const notificationInstances: {
  title: string;
  options: { body?: string; tag?: string };
  instance: FakeNotification;
}[] = [];

class FakeNotification {
  static permission: 'default' | 'granted' | 'denied' = 'default';
  onclick: (() => void) | null = null;
  close(): void {}
  constructor(
    title: string,
    options: { body?: string; tag?: string },
  ) {
    notificationInstances.push({ title, options, instance: this });
  }
}

let visibility = { hidden: false, hasFocus: true };

/** BroadcastChannel fake: postMessage delivers to every OTHER live instance. */
const broadcastHub: {
  posted: unknown[];
  instances: { listeners: ((event: { data: unknown }) => void)[] }[];
} = { posted: [], instances: [] };
class FakeBroadcastChannel {
  listeners: ((event: { data: unknown }) => void)[] = [];
  constructor(name: string) {
    if (name !== 'kortix-turn-complete') throw new Error(`unexpected channel ${name}`);
    broadcastHub.instances.push(this);
  }
  postMessage(data: unknown) {
    broadcastHub.posted.push(data);
    for (const instance of broadcastHub.instances) {
      if (instance === this) continue;
      for (const listener of instance.listeners) listener({ data });
    }
  }
  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
}

const world = globalThis as {
  document?: unknown;
  window?: unknown;
  Notification?: unknown;
  BroadcastChannel?: unknown;
};
world.document = {
  get hidden() {
    return visibility.hidden;
  },
  hasFocus: () => visibility.hasFocus,
};
world.window = {
  Notification: FakeNotification,
  // pathname is mutated per-test; assign is the navigation fallback path.
  location: { pathname: '/dashboard', assign: () => {} },
  history: { pushState: () => {}, replaceState: () => {} },
  focus: () => {},
};
world.Notification = FakeNotification;
world.BroadcastChannel = FakeBroadcastChannel;

/** The service worker's notifications: what it showed, and what is on screen by tag. */
const workerShown: { title: string; options: Record<string, unknown> }[] = [];
const workerOnScreen = new Map<string, { data: unknown }>();
Object.defineProperty(globalThis.navigator, 'serviceWorker', {
  configurable: true,
  value: {
    ready: Promise.resolve({
      showNotification: async (title: string, options: Record<string, unknown>) => {
        workerShown.push({ title, options });
        if (typeof options.tag === 'string') workerOnScreen.set(options.tag, { data: options.data });
      },
      getNotifications: async ({ tag }: { tag: string }) => {
        const shown = workerOnScreen.get(tag);
        return shown ? [shown] : [];
      },
    }),
  },
});

/** Lets the async service-worker path finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const {
  sendWebNotification,
  notifyTaskComplete,
  notifyTaskCompleteFor,
  isViewingSession,
  setServerPushPreferences,
} = await import('./web-notifications');
const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@kortix/sdk');
const { useWebNotificationStore } = await import('@/stores/web-notification-store');
const { useTabStore } = await import('@/stores/tab-store');
const { useTurnAttentionStore } = await import('@/stores/turn-attention-store');

/** The shipped preferences — what a customer who never opened the settings has. */
function defaultPreferences() {
  return { ...useWebNotificationStore.getInitialState().preferences };
}

function setPreferences(overrides: Partial<ReturnType<typeof defaultPreferences>>) {
  useWebNotificationStore.setState({ preferences: { ...defaultPreferences(), ...overrides } });
}

/** A finished-turn payload the way `notifyTaskComplete` raises it. */
function completionPayload() {
  return {
    type: 'completion' as const,
    title: 'Task complete',
    body: '"dogfood-1" has finished',
    tag: 'completion:sess1',
    sessionId: 'sess1',
    projectId: 'proj1',
    actionLabel: 'Open session',
  };
}

beforeEach(() => {
  toastCalls.length = 0;
  soundCalls.length = 0;
  notificationInstances.length = 0;
  visibility = { hidden: false, hasFocus: true };
  FakeNotification.permission = 'default';
  useWebNotificationStore.setState({ preferences: defaultPreferences() });
  useTabStore.setState({ activeTabId: null, tabs: {} });
  useTurnAttentionStore.setState({ unseen: [] });
  setServerPushPreferences(null);
  softNavigateCalls.length = 0;
  webPushOn = false;
  workerShown.length = 0;
  workerOnScreen.clear();
});

afterEach(() => {
  visibility = { hidden: false, hasFocus: true };
  useTabStore.setState({ activeTabId: null, tabs: {} });
  useTurnAttentionStore.setState({ unseen: [] });
});

describe('sendWebNotification — turn signals reach a customer watching another tab', () => {
  test('completion in a hidden tab fires the in-app toast on the default profile', () => {
    setPreferences({}); // never enabled browser notifications, sound off
    visibility = { hidden: true, hasFocus: false };

    sendWebNotification(completionPayload());

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('success');
    expect(toastCalls[0].title).toBe('Task complete');
  });

  test('completion in a hidden tab marks the session unseen for the favicon badge', () => {
    setPreferences({});
    visibility = { hidden: true, hasFocus: false };

    sendWebNotification(completionPayload());

    expect(useTurnAttentionStore.getState().unseen).toEqual(['sess1']);
  });

  test('completion while watching the session stays silent everywhere', () => {
    setPreferences({ enabled: true, playSound: true });
    visibility = { hidden: false, hasFocus: true };
    useTabStore.setState({ activeTabId: 'sess1' });

    sendWebNotification(completionPayload());

    expect(toastCalls).toHaveLength(0);
    expect(soundCalls).toHaveLength(0);
    expect(useTurnAttentionStore.getState().unseen).toEqual([]);
    expect(notificationInstances).toHaveLength(0);
  });

  test('completion in a hidden tab plays the sound when the sound preference is on', () => {
    setPreferences({ playSound: true });
    visibility = { hidden: true, hasFocus: false };

    sendWebNotification(completionPayload());

    expect(soundCalls).toEqual(['completion']);
  });

  test('completion on a visible tab watching another session plays the sound too', () => {
    setPreferences({ playSound: true });
    useTabStore.setState({ activeTabId: 'other-session' });

    sendWebNotification(completionPayload());

    expect(soundCalls).toEqual(['completion']);
  });

  test('a stale active tab id only counts as watching while the URL agrees with it', () => {
    // Regression for the review of KRTX-1795: the tab store never clears
    // activeTabId on navigation, so a tab parked on a project page would keep
    // silently suppressing toasts for a session it is not showing.
    useTabStore.setState({
      activeTabId: 'sess1',
      tabs: {
        sess1: {
          id: 'sess1',
          title: 'T',
          type: 'session',
          href: '/projects/p1/sessions/sess1',
          openedAt: 0,
          pinned: false,
        },
      },
    });
    const win = world.window as { location: { pathname: string } };
    const originalPathname = win.location.pathname;

    win.location.pathname = '/projects/p1/sessions/sess1';
    expect(isViewingSession('sess1')).toBe(true);

    // The user navigated elsewhere in this tab; the store never noticed.
    win.location.pathname = '/projects/p2';
    expect(isViewingSession('sess1')).toBe(false);

    win.location.pathname = originalPathname;
  });

  test('error in a hidden tab fires the error toast on the default profile', () => {
    visibility = { hidden: true, hasFocus: false };

    sendWebNotification({
      type: 'error',
      title: 'Session error',
      body: '"dogfood-1": boom',
      tag: 'error:sess1',
      sessionId: 'sess1',
    });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('error');
    // Errors are not finished turns: no badge.
    expect(useTurnAttentionStore.getState().unseen).toEqual([]);
  });

  test('OS notification still honours permission and the opt-in preferences', () => {
    setPreferences({}); // disabled
    visibility = { hidden: true, hasFocus: false };

    sendWebNotification(completionPayload());
    expect(notificationInstances).toHaveLength(0);

    setPreferences({ enabled: true });
    FakeNotification.permission = 'granted';
    sendWebNotification(completionPayload());
    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].options.tag).toBe('completion:sess1');
  });

  test('question while watching the session stays inline (no toast, no OS popup)', () => {
    setPreferences({ enabled: true });
    FakeNotification.permission = 'granted';
    useTabStore.setState({ activeTabId: 'sess1' });

    sendWebNotification({
      type: 'question',
      title: 'Kortix has a question',
      body: '"dogfood-1": continue?',
      tag: 'question:sess1',
      sessionId: 'sess1',
    });

    expect(toastCalls).toHaveLength(0);
    expect(notificationInstances).toHaveLength(0);
  });
});

/**
 * KRTX-1742: the per-browser per-kind switches (`onCompletion` …) are retired.
 * The person's Push choice per kind, saved on the server, gates the OS
 * notification instead — the same choice that gates Web Push and the phone.
 */
describe('sendWebNotification — the server Push choice gates each kind', () => {
  function enabledAndHidden() {
    setPreferences({ enabled: true });
    FakeNotification.permission = 'granted';
    visibility = { hidden: true, hasFocus: false };
  }

  test('a kind whose Push is off shows no OS notification, but still toasts', () => {
    enabledAndHidden();
    setServerPushPreferences({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      turn_done: { push: false, email: false },
    });

    sendWebNotification(completionPayload());

    expect(notificationInstances).toHaveLength(0);
    expect(toastCalls).toHaveLength(1);
  });

  test('another kind still shows, tagged <type>:<sessionId>', () => {
    enabledAndHidden();
    setServerPushPreferences({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      turn_done: { push: false, email: false },
    });

    sendWebNotification({
      type: 'question',
      title: 'Kortix has a question',
      body: '"dogfood-1": continue?',
      tag: 'question:sess1',
      sessionId: 'sess1',
    });

    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].options.tag).toBe('question:sess1');
  });

  test('before the preferences load every kind may notify, and the retired local switch does nothing', () => {
    enabledAndHidden();
    setPreferences({ enabled: true, onCompletion: false });

    sendWebNotification(completionPayload());

    expect(notificationInstances).toHaveLength(1);
  });

  test('an automation alert has no session: its toast and its OS notification open its href', () => {
    enabledAndHidden();

    sendWebNotification({
      type: 'automation_failed',
      title: 'Nightly report',
      body: 'Failure alert',
      tag: 'automation_failed:nightly-report',
      href: '/projects/proj1/customize/triggers',
      actionLabel: 'Open triggers',
    });

    expect(toastCalls[0].kind).toBe('error');
    const button = toastCalls[0].opts?.button as { props: { onClick: () => void } };
    button.props.onClick();
    notificationInstances[0].instance.onclick?.();
    expect(softNavigateCalls).toEqual([
      '/projects/proj1/customize/triggers',
      '/projects/proj1/customize/triggers',
    ]);
  });
});

describe('sendWebNotification — the toast open button', () => {
  test('runs the payload onClick, like a click on the OS notification', () => {
    visibility = { hidden: true, hasFocus: false };
    let clicks = 0;

    sendWebNotification({
      type: 'automation_failed',
      title: 'Nightly report',
      body: 'Failure alert',
      tag: 'automation_failed:proj1:nightly-report',
      href: '/projects/proj1/customize/triggers',
      actionLabel: 'Open triggers',
      onClick: () => {
        clicks += 1;
      },
    });

    const button = toastCalls[0].opts?.button as { props: { onClick: () => void } };
    button.props.onClick();
    expect(clicks).toBe(1);
    expect(softNavigateCalls).toEqual(['/projects/proj1/customize/triggers']);
  });
});

/**
 * KRTX-1742 review: a `new Notification` and a service-worker notification
 * never replace each other, even with one tag. While this browser holds a Web
 * Push subscription, the tab's copy goes through the service worker.
 */
describe('sendWebNotification — with a Web Push subscription the worker shows the copy', () => {
  function enabledAndHidden() {
    setPreferences({ enabled: true });
    FakeNotification.permission = 'granted';
    visibility = { hidden: true, hasFocus: false };
  }

  test('the worker shows it with the push tag and the session url, and no in-page notification', async () => {
    enabledAndHidden();
    webPushOn = true;

    expect(sendWebNotification(completionPayload())).toBeNull();
    await settle();

    expect(notificationInstances).toHaveLength(0);
    expect(workerShown).toEqual([
      {
        title: 'Task complete',
        options: {
          body: '"dogfood-1" has finished',
          icon: '/favicon.svg',
          tag: 'completion:sess1',
          renotify: false,
          data: { url: '/projects/proj1/sessions/sess1', at: (workerShown[0]?.options.data as { at: unknown }).at },
        },
      },
    ]);
    expect(typeof (workerShown[0].options.data as { at: unknown }).at).toBe('number');
    // The in-app channels still run.
    expect(toastCalls).toHaveLength(1);
  });

  test("a push for this event shown seconds ago is replaced quietly; an earlier event's alerts again", async () => {
    enabledAndHidden();
    webPushOn = true;

    workerOnScreen.set('completion:sess1', { data: { url: '/', at: Date.now() - 5_000 } });
    sendWebNotification(completionPayload());
    await settle();
    workerOnScreen.set('completion:sess1', { data: { url: '/', at: Date.now() - 120_000 } });
    sendWebNotification(completionPayload());
    await settle();

    expect(workerShown.map((shown) => shown.options.renotify)).toEqual([false, true]);
  });

  test('without a subscription, or for the settings test, the tab shows its own notification', async () => {
    enabledAndHidden();
    sendWebNotification(completionPayload());
    webPushOn = true;
    sendWebNotification(completionPayload(), true);
    await settle();

    expect(notificationInstances).toHaveLength(2);
    expect(workerShown).toHaveLength(0);
  });
});

describe('notifyTaskComplete — completions reach tabs that cannot hear the stream', () => {
  // Callable structural stand-in for the next-intl translator.
  const t = Object.assign((key: string) => `t:${key}`, {
    raw: (key: string) => `raw:${key}`,
  }) as unknown as Parameters<typeof notifyTaskComplete>[2];

  test('the stream entry point publishes to the cross-tab bridge and notifies locally', () => {
    setPreferences({});
    visibility = { hidden: true, hasFocus: false };
    broadcastHub.posted.length = 0;

    notifyTaskComplete('sess1', 'dogfood-1', t);

    expect(broadcastHub.posted).toHaveLength(1);
    expect(broadcastHub.posted[0]).toMatchObject({
      sessionId: 'sess1',
      sessionTitle: 'dogfood-1',
      projectId: null, // /dashboard carries no project id
    });
    // The publishing tab still runs its own notification path.
    expect(toastCalls).toHaveLength(1);
    expect(useTurnAttentionStore.getState().unseen).toEqual(['sess1']);
  });

  test('the local-only path does not publish — a relayed completion cannot loop', () => {
    setPreferences({});
    visibility = { hidden: true, hasFocus: false };
    broadcastHub.posted.length = 0;

    notifyTaskCompleteFor('sess1', 'dogfood-1', t, 'proj1');

    expect(broadcastHub.posted).toHaveLength(0);
    expect(toastCalls).toHaveLength(1);
  });

  test('a relayed projectId passes through verbatim — null stays null', () => {
    setPreferences({});
    visibility = { hidden: true, hasFocus: false };
    toastCalls.length = 0;
    softNavigateCalls.length = 0;

    // The publishing tab was not on a project page: null must not be
    // reinterpreted as THIS tab's project (the click-time fallback rule).
    notifyTaskCompleteFor('sess1', 'dogfood-1', t, null);
    const noProject = toastCalls[0]?.opts?.button as { props: { onClick: () => void } };
    noProject.props.onClick();
    expect(softNavigateCalls).toHaveLength(0);

    // A real projectId reaches the deep link unchanged.
    notifyTaskCompleteFor('sess2', 'dogfood-2', t, 'proj9');
    const withProject = toastCalls[1]?.opts?.button as { props: { onClick: () => void } };
    withProject.props.onClick();
    expect(softNavigateCalls).toHaveLength(1);
    expect(softNavigateCalls[0]).toContain('proj9');
    expect(softNavigateCalls[0]).toContain('sess2');
  });
});
